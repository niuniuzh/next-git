// pages/api/sync-organization.js (Pages Router)
// 或 app/api/sync-organization/route.js (App Router)

import { syncOrganizationRepos } from '../../lib/syncOrganizationRepos';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  const { organizationName } = req.body;

  if (!organizationName) {
    return res.status(400).json({ message: 'Organization name is required.' });
  }

  try {
    // 可以在这里进行权限验证，例如只允许特定用户触发
    // ...

    // 触发后台同步过程
    // 注意：对于长时间运行的任务，可能需要使用队列 (e.g., BullMQ, faktory)
    // 或 serverless function 的背景任务来处理，避免 API 路由超时。
    // 这里为了演示，直接调用，但对于大型组织可能超时。
    const result = await syncOrganizationRepos(organizationName);

    if (result.success) {
      return res.status(200).json({
        message: 'Organization repositories sync started.',
        details: result,
      });
    } else {
      return res.status(500).json({
        message: 'Failed to start organization repositories sync.',
        error: result.message,
      });
    }
  } catch (error) {
    console.error(`API Error /api/sync-organization:`, error);
    return res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
}
