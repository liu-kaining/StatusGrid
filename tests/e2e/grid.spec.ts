import { expect, test } from '@playwright/test';

test('filters actual provider results, indexed aliases, and restores browser history', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('provider-card')).toHaveCount(4);
  await page.getByRole('button', { name: 'AI 服务', exact: true }).click();
  await expect(page.getByTestId('provider-card')).toHaveCount(1);
  await expect(page.getByTestId('provider-card')).toContainText('OpenAI');
  await page.getByRole('button', { name: '全部', exact: true }).click();
  await page.getByLabel('仅看异常与受阻').check();
  await expect(page.getByTestId('provider-card')).toHaveCount(3);
  await page.goBack();
  await expect(page.getByTestId('provider-card')).toHaveCount(4);
  await page.getByRole('searchbox').fill('neural-endpoint');
  await expect(page.getByTestId('provider-card')).toHaveCount(3);
  await expect(page).toHaveURL(/q=neural-endpoint/);
  await page.getByRole('button', { name: '国内云', exact: true }).click();
  await expect(page.getByText('没有匹配的厂商')).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('searchbox')).toHaveValue('neural-endpoint');
  await expect(page.getByTestId('provider-card')).toHaveCount(3);
  await page.goForward();
  await expect(page.getByText('没有匹配的厂商')).toBeVisible();
  await expect(page.getByRole('button', { name: '国内云', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('official anchors navigate to real official URLs without opening details', async ({ page, context }) => {
  await context.route('https://status.openai.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>Official destination</h1>' }));
  await page.goto('/');
  const destination = context.waitForEvent('page');
  await page.getByTestId('provider-card').filter({ hasText: 'OpenAI' }).getByRole('link', { name: /官方状态/ }).click();
  const popup = await destination;
  await popup.waitForLoadState();
  expect(popup.url()).toContain('https://status.openai.com');
  await expect(popup.getByRole('heading', { name: 'Official destination' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
