import { expect, test } from '@playwright/test';

test('deep link restores the incident context and Escape closes the panel', async ({ page }) => {
  await page.goto('/?cat=ai&only_abnormal=1&provider=openai');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'OpenAI', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('Chat Completions');
  await expect(page.getByRole('dialog')).toContainText('仅覆盖配置');
  await expect(page.getByRole('dialog')).toContainText('us-east-1');
  await expect(page.getByRole('dialog').getByRole('heading', { name: /当前活跃事件/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).toHaveURL(/cat=ai/);
  await expect(page.getByTestId('provider-card')).toHaveCount(1);
});

test('detail updates remain text, the modal traps focus and restores its trigger', async ({ page }) => {
  await page.route('**/providers/openai.json', async (route) => {
    const response = await route.fetch();
    const detail = await response.json();
    detail.recentIncidents[0].updates[0].body = '<strong>Investigating</strong> elevated latency.';
    await route.fulfill({ response, json: detail });
  });
  await page.goto('/');
  const trigger = page.getByRole('button', { name: '查看 OpenAI 详情' });
  await trigger.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
  await dialog.locator('summary').filter({ hasText: '事件更新' }).click();
  await expect(dialog).toContainText('<strong>Investigating</strong>');
  expect(await dialog.locator('strong').count()).toBe(0);
  await dialog.getByRole('button', { name: '关闭详情' }).focus();
  await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(() => document.activeElement?.closest('[role=dialog]') !== null)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await page.goBack();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('snapshot age remains explicit while inspecting a provider', async ({ page }) => {
  await page.clock.install({ time: new Date() });
  await page.goto('/?provider=github');
  await expect(page.getByRole('dialog').getByTestId('component-row')).toHaveCount(1);
  await page.clock.fastForward(16 * 60_000);
  await expect(page.getByRole('dialog').locator('.status-badge')).toContainText('快照过期');
  await expect(page.getByRole('dialog')).toContainText('详情快照已过期');
  await expect(page.getByRole('dialog').locator('.component-state')).toHaveClass(/status-stale/);
  await expect(page.getByRole('dialog').locator('.component-state')).toContainText('上次：官方未报告异常');
  await page.keyboard.press('Escape');
  await expect(page.locator('.provider-card.status-operational')).toHaveCount(0);
  const github = page.getByTestId('provider-card').filter({ hasText: 'GitHub' });
  await expect(github).toHaveClass(/status-stale/);
  await expect(github.locator('.status-badge')).toContainText('快照过期');
  await expect(github).toContainText('上次可信状态：官方未报告异常');
  await expect(page.getByText('快照内可信源', { exact: true })).toBeVisible();
});
