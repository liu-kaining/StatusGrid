import { expect, test } from '@playwright/test';

test('initial missing snapshot never invents healthy provider cards', async ({ page }) => {
  await page.route('**/api/v1/manifest.json', (route) => route.fulfill({ status: 404, body: 'missing' }));
  await page.goto('/');
  await expect(page.getByText('尚无可用快照')).toBeVisible();
  await expect(page.getByTestId('provider-card')).toHaveCount(0);
});

test('refresh failure retains trusted cards and makes their age and failure visible', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('provider-card')).toHaveCount(4);
  await page.route('**/api/v1/manifest.json', (route) => route.abort());
  await page.getByRole('button', { name: '刷新数据' }).click();
  await expect(page.getByText(/刷新失败，保留上次可信快照/)).toBeVisible();
  await expect(page.getByTestId('provider-card')).toHaveCount(4);
  await expect(page.getByText(/数据年龄/).first()).toBeVisible();
});

test('search failure is visible and category filters still work', async ({ page }) => {
  await page.route('**/search.json', (route) => route.fulfill({ status: 503, body: 'unavailable' }));
  await page.goto('/');
  await page.getByRole('searchbox').fill('OpenAI');
  await expect(page.getByText(/搜索索引不可用/)).toBeVisible();
  await expect(page.getByTestId('provider-card')).toHaveCount(1);
  await page.getByRole('searchbox').fill('');
  await page.getByRole('button', { name: '国内云', exact: true }).click();
  await expect(page.getByTestId('provider-card')).toHaveCount(1);
  await expect(page.getByTestId('provider-card')).toContainText('采集受阻');
});

test('broken details and archives are explicit local failures', async ({ page }) => {
  await page.route('**/providers/openai.json', (route) => route.fulfill({ status: 200, json: { bad: true } }));
  await page.goto('/?provider=openai');
  await expect(page.getByRole('dialog')).toContainText('详情加载失败');
  await page.keyboard.press('Escape');
  await page.route('**/archive/indexes/**', (route) => route.fulfill({ status: 404, body: 'missing' }));
  await page.getByRole('button', { name: /Incident Vault/ }).click();
  await expect(page.getByText('历史加载失败')).toBeVisible();
  await expect(page.getByTestId('provider-card')).toHaveCount(0);
});

test('foreground checks run every sixty seconds and old snapshot ages remain visible', async ({ page }) => {
  await page.clock.install({ time: new Date() });
  let checks = 0;
  await page.route('**/api/v1/manifest.json', async (route) => { checks++; await route.continue(); });
  await page.goto('/');
  await expect(page.getByTestId('provider-card')).toHaveCount(4);
  const initialChecks = checks;
  await page.clock.fastForward(60_000);
  await expect.poll(() => checks).toBe(initialChecks + 1);
  await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, value: true }));
  await page.clock.fastForward(60_000);
  expect(checks).toBe(initialChecks + 1);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => checks).toBe(initialChecks + 2);
  await page.clock.fastForward(15 * 60_000);
  await expect(page.getByText('快照已过期', { exact: true })).toBeVisible();
  await expect(page.getByText(/当前为过期快照/)).toBeVisible();
  await expect(page.getByTestId('provider-card')).toHaveCount(4);
});
