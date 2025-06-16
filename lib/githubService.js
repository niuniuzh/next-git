/ lib/services/githubService.js
import { Octokit } from '@octokit/rest';
import pLimit from 'p-limit';

export class GitHubService {
  constructor() {
    this.octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN,
      request: {
        retries: 3,
        retryAfter: 3,
      }
    });
    
    // 限制并发请求数量，避免触发 GitHub API 限制
    this.concurrencyLimit = pLimit(parseInt(process.env.GITHUB_CONCURRENCY_LIMIT) || 10);
  }

  /**
   * 获取组织的所有仓库
   * @param {string} org - 组织名称
   * @returns {Promise<Array>} 仓库列表
   */
  async getOrgRepos(org) {
    try {
      const repos = [];
      let page = 1;
      const perPage = 100;

      while (true) {
        const response = await this.octokit.repos.listForOrg({
          org,
          type: 'all',
          sort: 'updated',
          direction: 'desc',
          per_page: perPage,
          page
        });

        repos.push(...response.data);

        if (response.data.length < perPage) {
          break;
        }
        page++;
      }

      return repos.filter(repo => !repo.archived && !repo.disabled);
    } catch (error) {
      console.error(`获取组织 ${org} 的仓库失败:`, error);
      throw error;
    }
  }

  /**
   * 检查仓库是否包含 package.json
   * @param {string} owner - 仓库所有者
   * @param {string} repo - 仓库名称
   * @returns {Promise<boolean>} 是否包含 package.json
   */
  async hasPackageJson(owner, repo) {
    try {
      await this.octokit.repos.getContent({
        owner,
        repo,
        path: 'package.json'
      });
      return true;
    } catch (error) {
      if (error.status === 404) {
        return false;
      }
      throw error;
    }
  }

  /**
   * 获取 package.json 内容
   * @param {string} owner - 仓库所有者
   * @param {string} repo - 仓库名称
   * @param {string} path - 文件路径，默认为 'package.json'
   * @returns {Promise<Object>} package.json 内容
   */
  async getPackageJson(owner, repo, path = 'package.json') {
    try {
      const response = await this.octokit.repos.getContent({
        owner,
        repo,
        path
      });

      if (response.data.type !== 'file') {
        throw new Error('package.json 不是文件类型');
      }

      const content = Buffer.from(response.data.content, 'base64').toString('utf8');
      return JSON.parse(content);
    } catch (error) {
      console.error(`获取 ${owner}/${repo} 的 package.json 失败:`, error);
      throw error;
    }
  }

  /**
   * 递归查找所有 package.json 文件
   * @param {string} owner - 仓库所有者
   * @param {string} repo - 仓库名称
   * @param {string} path - 搜索路径
   * @returns {Promise<Array>} package.json 文件路径列表
   */
  async findAllPackageJsons(owner, repo, path = '') {
    const packageJsons = [];
    
    try {
      const response = await this.octokit.repos.getContent({
        owner,
        repo,
        path
      });

      const contents = Array.isArray(response.data) ? response.data : [response.data];

      for (const item of contents) {
        if (item.type === 'file' && item.name === 'package.json') {
          packageJsons.push(item.path);
        } else if (item.type === 'dir' && !this.shouldSkipDirectory(item.name)) {
          // 递归搜索子目录，但跳过一些常见的无关目录
          const subPackageJsons = await this.findAllPackageJsons(owner, repo, item.path);
          packageJsons.push(...subPackageJsons);
        }
      }
    } catch (error) {
      if (error.status !== 404) {
        console.error(`搜索 ${owner}/${repo}/${path} 中的 package.json 失败:`, error);
      }
    }

    return packageJsons;
  }

  /**
   * 判断是否应该跳过某个目录
   * @param {string} dirName - 目录名称
   * @returns {boolean} 是否跳过
   */
  shouldSkipDirectory(dirName) {
    const skipDirs = [
      'node_modules',
      '.git',
      '.github',
      'dist',
      'build',
      'coverage',
      'docs',
      '.vscode',
      '.idea',
      'test',
      'tests',
      '__tests__'
    ];
    return skipDirs.includes(dirName) || dirName.startsWith('.');
  }

  /**
   * 批量处理仓库的 package.json
   * @param {string} org - 组织名称
   * @param {Function} processor - 处理函数
   * @param {Function} progressCallback - 进度回调
   * @returns {Promise<Object>} 处理结果统计
   */
  async processOrgPackageJsons(org, processor, progressCallback) {
    const stats = {
      totalRepos: 0,
      processedRepos: 0,
      successRepos: 0,
      errorRepos: 0,
      totalPackageJsons: 0,
      errors: []
    };

    try {
      // 获取所有仓库
      const repos = await this.getOrgRepos(org);
      stats.totalRepos = repos.length;

      console.log(`找到 ${repos.length} 个仓库`);

      // 并发处理仓库
      const tasks = repos.map(repo => 
        this.concurrencyLimit(async () => {
          try {
            const packageJsonPaths = await this.findAllPackageJsons(repo.owner.login, repo.name);
            
            if (packageJsonPaths.length === 0) {
              stats.processedRepos++;
              progressCallback?.(stats);
              return;
            }

            stats.totalPackageJsons += packageJsonPaths.length;

            // 处理每个 package.json
            for (const path of packageJsonPaths) {
              try {
                const packageJson = await this.getPackageJson(repo.owner.login, repo.name, path);
                const gitInfo = {
                  provider: 'github',
                  owner: repo.owner.login,
                  repo: repo.name,
                  branch: repo.default_branch,
                  url: repo.html_url,
                  sshUrl: repo.ssh_url,
                  stars: repo.stargazers_count,
                  forks: repo.forks_count,
                  size: repo.size,
                  language: repo.language,
                  path: path
                };

                await processor(packageJson, gitInfo);
              } catch (error) {
                console.error(`处理 ${repo.name}/${path} 失败:`, error);
                stats.errors.push({
                  repo: repo.name,
                  path,
                  error: error.message
                });
              }
            }

            stats.successRepos++;
          } catch (error) {
            console.error(`处理仓库 ${repo.name} 失败:`, error);
            stats.errorRepos++;
            stats.errors.push({
              repo: repo.name,
              error: error.message
            });
          } finally {
            stats.processedRepos++;
            progressCallback?.(stats);
          }
        })
      );

      await Promise.all(tasks);
      return stats;
    } catch (error) {
      console.error('批量处理失败:', error);
      throw error;
    }
  }

  /**
   * 获取 API 限制信息
   * @returns {Promise<Object>} API 限制信息
   */
  async getRateLimit() {
    try {
      const response = await this.octokit.rateLimit.get();
      return response.data;
    } catch (error) {
      console.error('获取 API 限制信息失败:', error);
      throw error;
    }
  }
}