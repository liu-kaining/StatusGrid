import { expect, test } from '@playwright/test';

test('history loads older month shards, filters providers/severity, and expands updates', async ({ page }) => {
  await page.goto('/?view=incidents&range=90d');
  await expect(page.getByTestId('incident')).toHaveCount(3);
  await expect(page.getByText('October API interruption')).toBeVisible();
  await page.getByLabel('历史时间范围').selectOption('month');
  const previous = new Date(); previous.setUTCMonth(previous.getUTCMonth() - 1);
  await page.getByLabel('归档月份').fill(previous.toISOString().slice(0, 7));
  await expect(page.getByTestId('incident')).toHaveCount(1);
  await page.locator('summary').filter({ hasText: '事件更新' }).click();
  await expect(page.getByText('Service restored.')).toBeVisible();
  await page.getByLabel('历史厂商').selectOption('github');
  await expect(page.getByText('此范围内没有事件')).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('incident')).toHaveCount(1);
  await page.getByLabel('严重度').selectOption('major_outage');
  await expect(page.getByText('此范围内没有事件')).toBeVisible();
});
