import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { RecentIncidents, Summary } from '../../src/shared/contracts.js';

/** Opt-in acceptance against a copied, unchanged live release; no external requests or collection. */
for (const width of [1440, 390]) {
  test(`real exporter data, lazy bounded Azure detail and themes at ${width}px`, async ({ page, request }, testInfo) => {
    const manifest = await (await request.get('/api/v1/manifest.json')).json();
    const summary: Summary = await (await request.get(manifest.paths.summary)).json();
    expect(summary.dataMode).toBe('live');
    // Read the independent published history, not the UI's day-filter helper.
    const publishedHistory: RecentIncidents = await (await request.get(manifest.paths.recentIncidents)).json();
    expect(publishedHistory.snapshotId).toBe(summary.snapshotId);
    expect(publishedHistory.dataMode).toBe('live');
    const date = summary.generatedAt.slice(0, 10);
    const dayStart = Date.parse(`${date}T00:00:00Z`);
    const dayEnd = dayStart + 86_400_000;
    const expectedEvents = publishedHistory.incidents.filter((event) => {
      if (event.providerId !== 'openai' || event.supersededBy) return false;
      const start = Date.parse(event.startedAt);
      const end = event.resolvedAt === null ? Date.parse(summary.generatedAt) : Date.parse(event.resolvedAt);
      return start === end ? start >= dayStart && start < dayEnd : start < dayEnd && end > dayStart;
    });
    const expired = Date.now() - Date.parse(summary.generatedAt) >= summary.intervalMinutes * 3 * 60_000;
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
    await expect(page.locator('.provider-card.status-stale')).toHaveCount(expired ? 13 : summary.providers.filter(({ status }) => status === 'stale').length);
    await expect(page.locator('.provider-card.status-operational')).toHaveCount(expired ? 0 : summary.providers.filter(({ status }) => status === 'operational').length);
    expect(detailRequests).toHaveLength(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 1440) {
      expect(await page.locator('.provider-grid').first().evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(3);
    }
    const timing = await page.evaluate(() => ({
      navigation: performance.getEntriesByType('navigation').map((entry) => entry.toJSON()),
      paints: performance.getEntriesByType('paint').map((entry) => entry.toJSON()),
      resources: performance.getEntriesByType('resource').map((entry) => entry.toJSON()),
    }));
    const output = resolve(process.env.STATUSGRID_LIVE_SCREENSHOT_DIR ?? '.statusgrid/acceptance/screenshots');
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
    if (expired) {
      await expect(dialog.locator('.status-badge')).toContainText('快照过期');
      await expect(dialog.locator('.component-state.status-operational')).toHaveCount(0);
      await expect(dialog).toContainText('上次：官方未报告异常');
    } else {
      await expect(dialog.locator('.status-badge')).not.toContainText('快照过期');
      await expect(dialog.getByTestId('component-row')).toHaveCount(80);
    }
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
    const cell = page.getByRole('link', { name: new RegExp(`OpenAI.*${date}`) }).first();
    await cell.hover();
    await expect(page.getByRole('tooltip')).toContainText(date);
    await expect(page.getByRole('tooltip')).not.toContainText('正在加载已记录事件');
    await expect(page.getByRole('tooltip')).not.toContainText('事件加载失败');
    await expect(page.getByRole('tooltip').locator('.day-popover-count')).toHaveText(`${expectedEvents.length} 条已记录事件`);
    for (const event of expectedEvents.slice(0, 3)) {
      await expect(page.getByRole('tooltip').getByText(event.title, { exact: true })).toBeVisible();
    }
    if (!expectedEvents.length) await expect(page.getByRole('tooltip')).toContainText('暂无已记录事件，不代表当日正常');
    await page.screenshot({ path: `${output}/live-hover-${width}.png`, animations: 'disabled' });
    await cell.click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('OpenAI');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(date);
    await expect(page.locator('.day-metrics')).toContainText('未知');
    await expect(page.getByText('正在加载已记录事件…', { exact: true })).toHaveCount(0);
    await expect(page.getByText('每日事件加载失败', { exact: true })).toHaveCount(0);
    await expect(page.locator('.day-events').getByTestId('incident')).toHaveCount(expectedEvents.length);
    for (const event of expectedEvents) {
      await expect(page.locator('.day-events').getByText(event.title, { exact: true })).toBeVisible();
    }
    if (!expectedEvents.length) await expect(page.locator('.day-events')).toContainText('暂无已记录事件');
    await expect(page.getByRole('link', { name: 'Snapshot JSON ↗' })).toHaveAttribute('href', manifest.paths.summary);
    await page.screenshot({ path: `${output}/live-day-${width}.png`, fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: '切换到浅色主题' }).click();
    await page.screenshot({ path: `${output}/live-day-light-${width}.png`, fullPage: true, animations: 'disabled' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const evidence = { viewport: width, snapshotId: summary.snapshotId, generatedAt: summary.generatedAt,
      checkedAt: new Date().toISOString(), expired, expectedDayEvents: expectedEvents.map(({ id, title }) => ({ id, title })),
      browserErrors, networkErrors, detailRequests, performance: timing };
    await testInfo.attach(`live-browser-evidence-${width}`, { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
    console.log(JSON.stringify({ ...evidence, performance: { paints: timing.paints, resourceCount: timing.resources.length } }));
    expect(browserErrors).toEqual([]);
    expect(networkErrors).toEqual([]);
  });
}
