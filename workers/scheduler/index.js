/**
 * @typedef {{ GITHUB_TOKEN?: string, GITHUB_REPOSITORY?: string, GITHUB_REF?: string }} Env
 */

export default {
  /**
   * @param {{ scheduledTime: number, cron: string }} controller
   * @param {Env} env
   */
  async scheduled(controller, env) {
    const token = env.GITHUB_TOKEN?.trim();
    const repository = env.GITHUB_REPOSITORY?.trim();
    const ref = env.GITHUB_REF?.trim();
    if (!token || !repository || !/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(repository) || !ref) {
      throw new Error('Invalid scheduler configuration: set GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_REF');
    }

    const scheduledAt = new Date(controller.scheduledTime).toISOString();
    const response = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/sync.yml/dispatches`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2026-03-10',
        'User-Agent': 'StatusGrid-Cloudflare-Scheduler',
      },
      body: JSON.stringify({ ref, inputs: { mode: 'sync', 'scheduled-at': scheduledAt } }),
    });
    const requestId = response.headers.get('x-github-request-id');
    if (!response.ok) {
      throw new Error(`GitHub dispatch failed: HTTP ${response.status}; request ID ${requestId ?? 'unavailable'}`);
    }

    console.log(JSON.stringify({
      event: 'github_dispatch_accepted',
      scheduledAt,
      cron: controller.cron,
      repository,
      ref,
      httpStatus: response.status,
      requestId,
    }));
  },
};
