import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Opt-in acceptance against a copied, unchanged live release; no external requests or collection. */
for (const width of [1440, 390]) {
  test(`real exporter data, lazy bounded Azure detail and themes at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1050 });
    const browserErrors: string[] = [];
    const networkErrors: string[] = [];
    const detailRequests: string[] = [];
    page.on('pageerror', (error) => browserErrors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()); });
    page.on('requestfailed', (request) => networkErrors.push(`${request.url()} ${request.failure()?.errorText}`));
    page.on('response', (response) => { if (response.status() >= 400) networkErrors.push(`${response.url()} HTTP${response.status()}`); });
    page.on('request', (request) => { if (/\/providers\/[^/]+\.json$/.test(request.url())) detailRequests.push(request.url()); });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('provider-card')).toHaveCount(13);
    await expect(page.getByText('FIXTURE / 演示数据')).toHaveCount(0);
    await expect(page.getByText(/数据年龄/).first()).toBeVisible();
    await expect(page.locator('.provider-card.status-stale')).toHaveCount(13);
    await expect(page.locator('.provider-card.status-operational')).toHaveCount(0);
    expect(detailRequests).toHaveLength(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 1440) {
      expect(await page.locator('.provider-grid').first().evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(3);
    }
    const output = resolve('.statusgrid/task8-screenshots');
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: `${output}/live-${width}.png`, fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: '切换到浅色主题' }).click();
    await page.screenshot({ path: `${output}/live-light-${width}.png`, fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: '切换到深色主题' }).click();
    const detailResponse = page.waitForResponse((response) => /\/providers\/azure\.json$/.test(response.url()));
    await page.getByRole('button', { name: '查看 Azure 详情' }).click();
    const artifact = await (await detailResponse).json();
    const totalComponents = artifact.componentGroups.reduce((count: number, group: { components: unknown[] }) => count + group.components.length, 0);
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('component-row')).toHaveCount(80);
    expect(totalComponents).toBeGreaterThan(7000);
    await expect(dialog).toContainText(`${totalComponents} COMPONENTS`);
    await expect(dialog.locator('.status-badge')).toContainText('快照过期');
    await expect(dialog.locator('.component-state.status-operational')).toHaveCount(0);
    await expect(dialog).toContainText('上次：官方未报告异常');
    expect(detailRequests).toHaveLength(1);
    await page.screenshot({ path: `${output}/live-azure-${width}.png`, animations: 'disabled' });
    await dialog.getByRole('button', { name: '再显示 80 个组件' }).click();
    await expect(dialog.getByTestId('component-row')).toHaveCount(160);
    await dialog.getByRole('searchbox').fill('nonexistent-component-987');
    await expect(dialog.getByTestId('component-row')).toHaveCount(0);
    await expect(dialog.getByText('没有匹配的组件')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '查看 Azure 详情' })).toBeFocused();
    const evidence = { viewport: width, browserErrors, networkErrors, detailRequests };
    await testInfo.attach(`live-browser-evidence-${width}`, { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
    console.log(JSON.stringify(evidence));
    expect(browserErrors).toEqual([]);
    expect(networkErrors).toEqual([]);
  });
}
