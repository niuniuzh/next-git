// lib/syncOrganizationRepos.js

import { PrismaClient } from '@prisma/client';
import { octokit, getPackageJsonContent } from './github';

const prisma = new PrismaClient();

const BATCH_SIZE = 10; // 每次并行处理的仓库数量，可以根据速率限制和服务器性能调整
const DELAY_BETWEEN_BATCHES = 2000; // 批处理之间等待的毫秒数，防止瞬间请求过多

/**
 * 遍历并同步指定组织下的所有仓库的 package.json 信息。
 * @param {string} orgName - GitHub 组织名称
 */
export async function syncOrganizationRepos(orgName) {
  console.log(`Starting sync for organization: ${orgName}`);
  let successCount = 0;
  let noPackageJsonCount = 0;
  let errorCount = 0;

  try {
    // 1. 获取或创建组织
    let organization = await prisma.organization.upsert({
      where: { name: orgName },
      update: {},
      create: { name: orgName },
    });

    console.log(`Processing organization: ${organization.name} (ID: ${organization.id})`);

    // 2. 获取组织下的所有仓库
    const reposIterator = octokit.paginate.iterator(octokit.repos.listForOrg, {
      org: orgName,
      type: 'all',
      per_page: 100, // 每次请求的仓库数量
    });

    let allRepos = [];
    for await (const { data: repos } of reposIterator) {
      allRepos.push(...repos);
    }
    console.log(`Found ${allRepos.length} repositories in ${orgName}.`);

    // 3. 分批并行处理仓库
    for (let i = 0; i < allRepos.length; i += BATCH_SIZE) {
      const batch = allRepos.slice(i, i + BATCH_SIZE);
      console.log(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(allRepos.length / BATCH_SIZE)} (${batch.length} repos)`);

      const batchPromises = batch.map(async (githubRepo) => {
        let transaction;
        try {
          transaction = await prisma.$transaction(async (tx) => {
            // 获取或更新仓库信息
            const commonRepoData = {
              organizationId: organization.id,
              name: githubRepo.name,
              fullName: githubRepo.full_name,
              url: githubRepo.html_url,
              defaultBranch: githubRepo.default_branch || 'main',
              description: githubRepo.description,
              githubId: githubRepo.id,
              lastFetchedAt: new Date(), // 记录尝试获取的时间
            };

            const repository = await tx.repository.upsert({
              where: { githubId: githubRepo.id },
              update: commonRepoData,
              create: commonRepoData,
            });

            // 检查上次更新时间：如果仓库的 GitHub updated_at 早于我们上次抓取的时间，并且它已经有 package.json 记录，
            // 那么我们可以跳过重新抓取 package.json，从而优化性能。
            // 但为了简单起见，这里总是尝试抓取，如果你需要极致的优化，可以在这里添加逻辑。
            // 例如：if (repository.lastFetchedAt && new Date(githubRepo.updated_at) < repository.lastFetchedAt && repository.hasPackageJson) { /* skip */ }

            const { content: packageJsonContent, status } = await getPackageJsonContent(githubRepo.owner.login, githubRepo.name);

            if (status === 200 && packageJsonContent) {
              const packageJson = JSON.parse(packageJsonContent);
              await tx.packageJson.upsert({
                where: { repositoryId: repository.id },
                update: {
                  name: packageJson.name,
                  version: packageJson.version,
                  description: packageJson.description,
                  author: packageJson.author,
                  license: packageJson.license,
                  dependencies: packageJson.dependencies || {},
                  devDependencies: packageJson.devDependencies || {},
                  scripts: packageJson.scripts || {},
                  fullContent: packageJson,
                  fetchedAt: new Date(),
                },
                create: {
                  repositoryId: repository.id,
                  name: packageJson.name,
                  version: packageJson.version,
                  description: packageJson.description,
                  author: packageJson.author,
                  license: packageJson.license,
                  dependencies: packageJson.dependencies || {},
                  devDependencies: packageJson.devDependencies || {},
                  scripts: packageJson.scripts || {},
                  fullContent: packageJson,
                  fetchedAt: new Date(),
                },
              });
              await tx.repository.update({
                where: { id: repository.id },
                data: { hasPackageJson: true },
              });
              successCount++;
              console.log(`  ✅ Processed ${githubRepo.full_name}`);
            } else if (status === 404) {
              // package.json 不存在，删除旧记录（如果有的话）
              await tx.packageJson.deleteMany({
                where: { repositoryId: repository.id },
              });
              await tx.repository.update({
                where: { id: repository.id },
                data: { hasPackageJson: false },
              });
              noPackageJsonCount++;
              console.log(`  ⚠️ No package.json for ${githubRepo.full_name}`);
            } else {
              // 其他错误，记录但不中断
              console.error(`  ❌ Error processing ${githubRepo.full_name}: Status ${status}`);
              errorCount++;
            }
          });
        } catch (repoError) {
          console.error(`  Critical error for ${githubRepo.full_name} in transaction:`, repoError.message);
          errorCount++;
          // Prisma 事务会在错误时自动回滚
        }
      });

      // 等待当前批次完成
      await Promise.allSettled(batchPromises);

      // 在批次之间添加延迟，以避免瞬间过多的请求，进一步缓解速率限制
      if (i + BATCH_SIZE < allRepos.length) {
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
      }
    }

    console.log(`Sync complete for ${orgName}:`);
    console.log(`  Successful package.json processed: ${successCount}`);
    console.log(`  Repositories without package.json: ${noPackageJsonCount}`);
    console.log(`  Errors encountered: ${errorCount}`);

    return { success: true, message: 'Sync complete.', successCount, noPackageJsonCount, errorCount };
  } catch (error) {
    console.error(`Error syncing organization ${orgName}:`, error.message);
    return { success: false, message: `Failed to sync organization: ${error.message}` };
  } finally {
    await prisma.$disconnect();
  }
}
