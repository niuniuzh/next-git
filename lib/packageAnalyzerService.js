// lib/services/packageAnalyzerService.js
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import pLimit from 'p-limit';

// 创建全局 Prisma 实例
const globalForPrisma = globalThis;
const prisma = globalForPrisma.prisma || new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export class PackageAnalyzerService {
  constructor() {
    this.prisma = prisma;
    // 限制并发数据库操作
    this.dbConcurrencyLimit = pLimit(parseInt(process.env.DB_CONCURRENCY_LIMIT) || 5);
    
    // 批处理配置
    this.batchSize = parseInt(process.env.BATCH_SIZE) || 50;
    this.batchBuffer = {
      projects: [],
      dependencies: [],
      scripts: [],
      keywords: [],
      people: []
    };
  }

  /**
   * 分析并保存单个 package.json
   * @param {Object} packageJsonContent - package.json 内容
   * @param {Object} gitInfo - Git 仓库信息
   * @returns {Promise<Object>} 分析结果
   */
  async analyzeAndSave(packageJsonContent, gitInfo = {}) {
    return this.dbConcurrencyLimit(async () => {
      const packageHash = crypto
        .createHash('sha256')
        .update(JSON.stringify(packageJsonContent))
        .digest('hex');
      
      try {
        const result = await this.prisma.$transaction(async (tx) => {
          // 1. 保存/更新项目信息
          const project = await this.saveProject(tx, packageJsonContent, gitInfo, packageHash);
          
          // 2. 批量保存关联数据
          await Promise.all([
            this.saveDependencies(tx, project.id, packageJsonContent),
            this.saveScripts(tx, project.id, packageJsonContent),
            this.saveKeywords(tx, project.id, packageJsonContent),
            this.savePeople(tx, project.id, packageJsonContent)
          ]);
          
          // 3. 更新统计信息
          await this.updateProjectStats(tx, project.id);
          
          return { success: true, projectId: project.id };
        }, {
          timeout: 30000, // 30秒超时
        });
        
        return result;
      } catch (error) {
        console.error('分析保存失败:', error);
        throw error;
      }
    });
  }

  /**
   * 批量分析处理
   * @param {Array} packageDataList - 包数据列表
   * @returns {Promise<Object>} 批处理结果
   */
  async batchAnalyze(packageDataList) {
    const results = {
      success: 0,
      failed: 0,
      errors: []
    };

    // 分批处理
    for (let i = 0; i < packageDataList.length; i += this.batchSize) {
      const batch = packageDataList.slice(i, i + this.batchSize);
      
      try {
        await this.processBatch(batch);
        results.success += batch.length;
      } catch (error) {
        console.error(`批次 ${Math.floor(i / this.batchSize) + 1} 处理失败:`, error);
        results.failed += batch.length;
        results.errors.push({
          batch: Math.floor(i / this.batchSize) + 1,
          error: error.message
        });
      }
    }

    return results;
  }

  /**
   * 处理单个批次
   * @param {Array} batch - 批次数据
   */
  async processBatch(batch) {
    const projectsData = [];
    const allDependencies = [];
    const allScripts = [];
    const allKeywords = [];
    const allPeople = [];

    // 预处理所有数据
    for (const { packageJson, gitInfo } of batch) {
      const packageHash = crypto
        .createHash('sha256')
        .update(JSON.stringify(packageJson))
        .digest('hex');

      const projectData = this.prepareProjectData(packageJson, gitInfo, packageHash);
      projectsData.push(projectData);
    }

    // 使用事务批量插入
    await this.prisma.$transaction(async (tx) => {
      // 批量 upsert 项目
      const projects = [];
      for (const projectData of projectsData) {
        const project = await tx.project.upsert({
          where: { name: projectData.name },
          update: {
            version: projectData.version,
            description: projectData.description,
            packageJsonHash: projectData.packageJsonHash,
            lastAnalyzedAt: new Date()
          },
          create: projectData
        });
        projects.push(project);
      }

      // 为每个项目准备关联数据
      for (let i = 0; i < batch.length; i++) {
        const { packageJson } = batch[i];
        const project = projects[i];

        // 清理旧数据
        await Promise.all([
          tx.projectDependency.deleteMany({ where: { projectId: project.id } }),
          tx.projectScript.deleteMany({ where: { projectId: project.id } }),
          tx.projectKeyword.deleteMany({ where: { projectId: project.id } }),
          tx.projectPerson.deleteMany({ where: { projectId: project.id } })
        ]);

        // 准备新数据
        allDependencies.push(...this.prepareDependenciesData(project.id, packageJson));
        allScripts.push(...this.prepareScriptsData(project.id, packageJson));
        allKeywords.push(...this.prepareKeywordsData(project.id, packageJson));
        allPeople.push(...this.preparePeopleData(project.id, packageJson));
      }

      // 批量插入关联数据
      await Promise.all([
        allDependencies.length > 0 && tx.projectDependency.createMany({ data: allDependencies }),
        allScripts.length > 0 && tx.projectScript.createMany({ data: allScripts }),
        allKeywords.length > 0 && tx.projectKeyword.createMany({ data: allKeywords }),
        allPeople.length > 0 && tx.projectPerson.createMany({ data: allPeople })
      ].filter(Boolean));
    });
  }

  /**
   * 保存项目信息
   */
  async saveProject(tx, pkg, gitInfo, packageHash) {
    const projectData = this.prepareProjectData(pkg, gitInfo, packageHash);

    return await tx.project.upsert({
      where: { name: projectData.name },
      update: {
        version: projectData.version,
        description: projectData.description,
        homepage: projectData.homepage,
        license: projectData.license,
        mainFile: projectData.mainFile,
        moduleFile: projectData.moduleFile,
        typesFile: projectData.typesFile,
        browserFile: projectData.browserFile,
        packageJsonHash: projectData.packageJsonHash,
        repoStars: projectData.repoStars,
        repoForks: projectData.repoForks,
        repoSize: projectData.repoSize,
        repoLanguage: projectData.repoLanguage,
        lastAnalyzedAt: new Date()
      },
      create: projectData
    });
  }

  /**
   * 准备项目数据
   */
  prepareProjectData(pkg, gitInfo, packageHash) {
    return {
      name: this.generateUniqueName(pkg.name, gitInfo),
      version: pkg.version || '0.0.0',
      description: pkg.description || null,
      homepage: pkg.homepage || null,
      gitProvider: gitInfo.provider || 'github',
      gitOwner: gitInfo.owner || null,
      gitRepo: gitInfo.repo || null,
      gitBranch: gitInfo.branch || 'main',
      gitUrl: gitInfo.url || null,
      gitSshUrl: gitInfo.sshUrl || null,
      license: this.extractLicense(pkg.license),
      licenseUrl: this.extractLicenseUrl(pkg.license),
      mainFile: pkg.main || null,
      moduleFile: pkg.module || null,
      typesFile: pkg.types || pkg.typings || null,
      browserFile: typeof pkg.browser === 'string' ? pkg.browser : null,
      isPrivate: pkg.private || false,
      projectType: this.detectProjectType(pkg),
      packageManager: this.detectPackageManager(pkg),
      packageManagerVersion: this.extractPackageManagerVersion(pkg),
      packageJsonHash: packageHash,
      repoStars: gitInfo.stars || 0,
      repoForks: gitInfo.forks || 0,
      repoSize: gitInfo.size || 0,
      repoLanguage: gitInfo.language || null,
      lastAnalyzedAt: new Date()
    };
  }

  /**
   * 生成唯一名称（处理重名问题）
   */
  generateUniqueName(packageName, gitInfo) {
    if (!packageName || packageName === 'unknown') {
      return `${gitInfo.owner}/${gitInfo.repo}${gitInfo.path !== 'package.json' ? `/${gitInfo.path}` : ''}`;
    }
    
    // 如果是 monorepo 中的子包，添加路径信息
    if (gitInfo.path && gitInfo.path !== 'package.json') {
      return `${packageName}@${gitInfo.owner}/${gitInfo.repo}/${gitInfo.path}`;
    }
    
    return packageName;
  }

  /**
   * 保存依赖项
   */
  async saveDependencies(tx, projectId, pkg) {
    await tx.projectDependency.deleteMany({ where: { projectId } });
    
    const dependencies = this.prepareDependenciesData(projectId, pkg);
    if (dependencies.length > 0) {
      await tx.projectDependency.createMany({ data: dependencies });
    }
  }

  /**
   * 准备依赖数据
   */
  prepareDependenciesData(projectId, pkg) {
    const dependencies = [];
    const depTypes = [
      { key: 'dependencies', type: 'PRODUCTION' },
      { key: 'devDependencies', type: 'DEVELOPMENT' },
      { key: 'peerDependencies', type: 'PEER' },
      { key: 'optionalDependencies', type: 'OPTIONAL' },
      { key: 'bundledDependencies', type: 'BUNDLED' },
      { key: 'bundleDependencies', type: 'BUNDLED' }
    ];

    for (const { key, type } of depTypes) {
      if (pkg[key] && typeof pkg[key] === 'object') {
        for (const [name, version] of Object.entries(pkg[key])) {
          dependencies.push({
            projectId,
            packageName: name,
            version: String(version),
            dependencyType: type
          });
        }
      }
    }

    return dependencies;
  }

  /**
   * 保存脚本
   */
  async saveScripts(tx, projectId, pkg) {
    await tx.projectScript.deleteMany({ where: { projectId } });
    
    const scripts = this.prepareScriptsData(projectId, pkg);
    if (scripts.length > 0) {
      await tx.projectScript.createMany({ data: scripts });
    }
  }

  /**
   * 准备脚本数据
   */
  prepareScriptsData(projectId, pkg) {
    const scripts = [];
    if (pkg.scripts && typeof pkg.scripts === 'object') {
      for (const [name, command] of Object.entries(pkg.scripts)) {
        scripts.push({
          projectId,
          scriptName: name,
          command: String(command)
        });
      }
    }
    return scripts;
  }

  /**
   * 保存关键词
   */
  async saveKeywords(tx, projectId, pkg) {
    await tx.projectKeyword.deleteMany({ where: { projectId } });
    
    const keywords = this.prepareKeywordsData(projectId, pkg);
    if (keywords.length > 0) {
      await tx.projectKeyword.createMany({ data: keywords });
    }
  }

  /**
   * 准备关键词数据
   */
  prepareKeywordsData(projectId, pkg) {
    const keywords = [];
    if (pkg.keywords && Array.isArray(pkg.keywords)) {
      for (const keyword of pkg.keywords) {
        if (keyword && typeof keyword === 'string') {
          keywords.push({
            projectId,
            keyword: keyword.trim()
          });
        }
      }
    }
    return keywords;
  }

  /**
   * 保存人员信息
   */
  async savePeople(tx, projectId, pkg) {
    await tx.projectPerson.deleteMany({ where: { projectId } });
    
    const people = this.preparePeopleData(projectId, pkg);
    if (people.length > 0) {
      await tx.projectPerson.createMany({ data: people });
    }
  }

  /**
   * 准备人员数据
   */
  preparePeopleData(projectId, pkg) {
    const people = [];

    // 处理作者
    if (pkg.author) {
      const author = this.parsePersonString(pkg.author);
      if (author.name) {
        people.push({
          projectId,
          name: author.name,
          email: author.email,
          url: author.url,
          role: 'AUTHOR'
        });
      }
    }

    // 处理贡献者
    if (pkg.contributors && Array.isArray(pkg.contributors)) {
      for (const contributor of pkg.contributors) {
        const person = this.parsePersonString(contributor);
        if (person.name) {
          people.push({
            projectId,
            name: person.name,
            email: person.email,
            url: person.url,
            role: 'CONTRIBUTOR'
          });
        }
      }
    }

    // 处理维护者
    if (pkg.maintainers && Array.isArray(pkg.maintainers)) {
      for (const maintainer of pkg.maintainers) {
        const person = this.parsePersonString(maintainer);
        if (person.name) {
          people.push({
            projectId,
            name: person.name,
            email: person.email,
            url: person.url,
            role: 'MAINTAINER'
          });
        }
      }
    }

    return people;
  }

  /**
   * 更新项目统计信息
   */
  async updateProjectStats(tx, projectId) {
    const [depCount, scriptCount, keywordCount] = await Promise.all([
      tx.projectDependency.count({ where: { projectId } }),
      tx.projectScript.count({ where: { projectId } }),
      tx.projectKeyword.count({ where: { projectId } })
    ]);

    await tx.project.update({
      where: { id: projectId },
      data: {
        totalDependencies: depCount,
        totalScripts: scriptCount,
        totalKeywords: keywordCount
      }
    });
  }
}