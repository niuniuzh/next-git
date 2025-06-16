import { Octokit } from '@octokit/rest';
import { PrismaClient } from '@prisma/client';
import { NextRequest, NextResponse } from 'next/server';

// Types
interface PackageJson {
    name?: string;
    version?: string;
    description?: string;
    author?: string;
    license?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
}

interface RequestBody {
    organization: string;
    repoName: string;
}

// Initialize Prisma client as a singleton
const prisma = new PrismaClient();

// Initialize Octokit with rate limiting
const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
    timeZone: 'UTC',
    baseUrl: 'https://api.github.com',
    log: {
        debug: () => { },
        info: () => { },
        warn: console.warn,
        error: console.error
    }
});

// Helper functions
async function getRepositoryDetails(orgName: string, repoName: string) {
    try {
        const { data } = await octokit.repos.get({
            owner: orgName,
            repo: repoName,
        });
        return data;
    } catch (error: any) {
        if (error.status === 404) {
            throw new Error('Repository not found');
        }
        throw error;
    }
}

async function getPackageJsonContent(orgName: string, repoName: string) {
    try {
        const { data } = await octokit.repos.getContent({
            owner: orgName,
            repo: repoName,
            path: 'package.json',
        });

        if ('content' in data) {
            return Buffer.from(data.content, 'base64').toString('utf8');
        }
        throw new Error('Invalid package.json content');
    } catch (error: any) {
        if (error.status === 404) {
            return null;
        }
        throw error;
    }
}

export async function POST(request: NextRequest) {
    if (!process.env.GITHUB_TOKEN) {
        return NextResponse.json(
            { success: false, message: 'GitHub token is not configured' },
            { status: 500 }
        );
    }

    try {
        const body = await request.json() as RequestBody;
        const { organization: orgName, repoName } = body;

        if (!orgName || !repoName) {
            return NextResponse.json(
                { success: false, message: 'Organization and repository name are required' },
                { status: 400 }
            );
        }

        // Use transaction for database operations
        const result = await prisma.$transaction(async (tx) => {
            // Get or create organization
            const organization = await tx.organizations.upsert({
                where: { name: orgName },
                update: {},
                create: { name: orgName, id: 0 },
            });

            // Get repository details from GitHub
            const repoDetails = await getRepositoryDetails(orgName, repoName);

            // Update or create repository
            const repository = await tx.repositories.upsert({
                where: { full_name: `${orgName}/${repoName}` },
                update: {
                    name: repoName,
                    description: repoDetails.description,
                    url: repoDetails.html_url,
                    default_branch: repoDetails.default_branch,
                    github_id: repoDetails.id,
                    last_fetched_at: new Date(),
                },
                create: {
                    id: Math.floor(Math.random() * 1000000),
                    organization_id: organization.id,
                    name: repoName,
                    full_name: `${orgName}/${repoName}`,
                    description: repoDetails.description,
                    url: repoDetails.html_url,
                    default_branch: repoDetails.default_branch,
                    github_id: repoDetails.id,
                    has_package_json: false,
                    last_fetched_at: new Date(),
                },
            });

            // Get package.json content
            const packageJsonContent = await getPackageJsonContent(orgName, repoName);

            if (!packageJsonContent) {
                // Delete existing package.json if repository no longer has one
                await tx.package_jsons.deleteMany({
                    where: { repository_id: repository.id },
                });

                await tx.repositories.update({
                    where: { id: repository.id },
                    data: { has_package_json: false },
                });

                return { success: true, message: `No package.json found for ${repoName}` };
            }

            // Parse and validate package.json
            const packageJson = JSON.parse(packageJsonContent) as PackageJson;

            // Update repository and package.json
            await tx.repositories.update({
                where: { id: repository.id },
                data: { has_package_json: true },
            });

            await tx.package_jsons.upsert({
                where: { repository_id: repository.id },
                update: {
                    name: packageJson.name,
                    version: packageJson.version,
                    description: packageJson.description,
                    author: typeof packageJson.author === 'string' ? packageJson.author : JSON.stringify(packageJson.author),
                    license: packageJson.license,
                    dependencies: JSON.stringify(packageJson.dependencies || {}),
                    dev_dependencies: JSON.stringify(packageJson.devDependencies || {}),
                    scripts: JSON.stringify(packageJson.scripts || {}),
                    full_content: packageJsonContent,
                    fetched_at: new Date(),
                },
                create: {
                    repository_id: repository.id,
                    name: packageJson.name,
                    version: packageJson.version,
                    description: packageJson.description,
                    author: typeof packageJson.author === 'string' ? packageJson.author : JSON.stringify(packageJson.author),
                    license: packageJson.license,
                    dependencies: JSON.stringify(packageJson.dependencies || {}),
                    dev_dependencies: JSON.stringify(packageJson.devDependencies || {}),
                    scripts: JSON.stringify(packageJson.scripts || {}),
                    full_content: packageJsonContent,
                    fetched_at: new Date(),
                },
            });

            return { success: true, message: `Successfully processed package.json for ${repoName}` };
        });

        return NextResponse.json(result);
    } catch (error: any) {
        console.error('Error processing package.json:', error);

        const status = error.message === 'Repository not found' ? 404 : 500;
        const message = error.message === 'Repository not found'
            ? 'Repository not found'
            : 'Failed to process package.json';

        return NextResponse.json(
            { success: false, message, error: error.message },
            { status }
        );
    } finally {
        await prisma.$disconnect();
    }
} 