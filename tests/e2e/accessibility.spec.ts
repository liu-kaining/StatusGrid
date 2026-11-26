import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

for (const width of [1440, 390]) {
  test(`keyboard, themes, layout and browser errors at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1050 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('requestfailed', (request) => errors.push(`${request.url()} ${request.failure()?.errorText}`));
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('provider-card')).toHaveCount(4);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.keyboard.press('/');
    await expect(page.getByRole('searchbox')).toBeFocused();
    await page.keyboard.type('OpenAI');
    await expect(page.getByTestId('provider-card')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('searchbox')).toHaveValue('');
    await page.getByRole('button', { name: '切换到浅色主题' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const output = resolve('.statusgrid/screenshots/layout');
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: `${output}/fixture-light-${width}.png`, fullPage: true, animations: 'disabled' });
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.getByRole('button', { name: '切换到深色主题' }).click();
    await page.screenshot({ path: `${output}/fixture-${width}.png`, fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: '查看 OpenAI 详情' }).click();
    await expect(page.getByRole('dialog')).toContainText('Chat Completions');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `${output}/fixture-detail-${width}.png`, animations: 'disabled' });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: '查看 OpenAI 详情' })).toBeFocused();
    expect(errors).toEqual([]);
  });
}
