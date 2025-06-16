import { Octokit } from '@octokit/rest';
import { throttling } from '@octokit/plugin-throttling'; // 用于处理速率限制
import { retry } from '@octokit/plugin-retry';     // 用于处理临时网络错误

// 组合插件
const MyOctokit = Octokit.plugin(throttling, retry);

const githubToken = process.env.GITHUB_TOKEN;

if (!githubToken) {
  console.error('GITHUB_TOKEN is not set in your .env.local file. Please set it.');
  // 在生产环境中，应该抛出错误或有更健壮的启动检查
}

export const octokit = new MyOctokit({
  auth: githubToken,
  // 节流配置，非常重要！
  throttle: {
    onRateLimit: (retryAfter, options, octokit, retryCount) => {
      octokit.log.warn(
        `Request quota exhausted for request ${options.method} ${options.url}. ` +
        `Retrying after ${retryAfter} seconds!`
      );

      if (retryCount < 5) { // 最多重试5次
        return true; // 继续重试
      }
    },
    onAbuseLimit: (retryAfter, options, octokit, retryCount) => {
      octokit.log.error(
        `Abuse detected for request ${options.method} ${options.url}. ` +
        `Retrying after ${retryAfter} seconds!`
      );
      if (retryCount < 5) { // 最多重试5次
        return true; // 继续重试
      }
    },
  },
  // 重试配置
  retry: {
    doNotRetry: ["429"], // 429 (Too Many Requests) 由 throttling 插件处理
  },
});

/**
 * 从 GitHub 获取 package.json 内容。
 * @param {string} owner - 仓库所有者 (组织名)
 * @param {string} repo - 仓库名
 * @returns {Promise<{ content: string | null, error: Error | null, status: number }>} - 返回 package.json 内容、错误或状态码
 */
export async function getPackageJsonContent(owner, repo) {
  try {
    const { data, status } = await octokit.repos.getContent({
      owner,
      repo,
      path: 'package.json',
    });
    // GitHub API 返回的文件内容是 base64 编码的
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    return { content, error: null, status };
  } catch (error) {
    if (error.status === 404) {
      return { content: null, error: new Error('package.json not found'), status: 404 };
    }
    console.error(`Error fetching package.json for ${owner}/${repo}:`, error.message);
    return { content: null, error: error, status: error.status || 500 };
  }
}