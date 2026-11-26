import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

// Optional read-only visual pass against the existing local preview; fixture mode stays the default.
for (const width of [1440, 390]) {
  for (const theme of ['dark', 'light'] as const) {
    test(`themed menus and health coverage remain usable at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1050 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
      page.on('requestfailed', (request) => errors.push(`${request.url()} ${request.failure()?.errorText}`));
      await page.goto(process.env.STATUSGRID_UI_URL ?? '/');
      await page.waitForLoadState('networkidle');
      await expect(page.getByTestId('provider-card').first()).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const output = resolve('.statusgrid/screenshots/controls');
      await mkdir(output, { recursive: true });
      const prefix = `${process.env.STATUSGRID_UI_URL ? 'live' : 'fixture'}-${theme}-${width}`;
      await page.screenshot({ path: `${output}/${prefix}-grid.png`, fullPage: true, animations: 'disabled' });
      const card = page.getByTestId('provider-card').filter({ hasText: 'OpenAI' });
      await card.screenshot({ path: `${output}/${prefix}-health.png`, animations: 'disabled' });
      await page.getByRole('button', { name: /Incident Vault/ }).click();
      const provider = page.getByRole('combobox', { name: '历史厂商', exact: true });
      await provider.click();
      await page.keyboard.press('End');
      const options = page.getByRole('option');
      await expect(provider).toHaveAttribute('aria-activedescendant', (await options.last().getAttribute('id'))!);
      const listbox = page.getByRole('listbox', { name: '历史厂商选项', exact: true });
      if (await options.count() > 8) expect(await listbox.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `${output}/${prefix}-providers.png`, animations: 'disabled' });
      await page.keyboard.press('Escape');
      await expect(provider).toBeFocused();
      await expect(provider).toContainText('全部厂商');
      const range = page.getByRole('combobox', { name: '历史时间范围', exact: true });
      await range.click();
      await expect(page.getByRole('option', { selected: true })).toHaveAccessibleName('近 30 天');
      await page.screenshot({ path: `${output}/${prefix}-range.png`, animations: 'disabled' });
      await page.keyboard.press('Escape');
      await expect(range).toBeFocused();
      expect(errors).toEqual([]);
    });
  }
}

test('touch selection changes actual history results without a native popup', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, colorScheme: 'light' });
  const page = await context.newPage();
  try {
    await page.goto('/?view=incidents&range=90d');
    await expect(page.getByTestId('incident')).toHaveCount(3);
    const range = page.getByRole('combobox', { name: '历史时间范围', exact: true });
    await range.tap();
    await page.getByRole('option', { name: '近 7 天', exact: true }).tap();
    await expect(range).toContainText('近 7 天');
    await expect(page.getByTestId('incident')).toHaveCount(2);
    await expect(page).toHaveURL(/range=7d/);
    await range.tap();
    await page.getByRole('heading', { name: /每一次异常/ }).tap();
    await expect(page.getByRole('listbox')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await context.close(); }
});
