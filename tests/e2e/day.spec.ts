import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Manifest } from '../../src/shared/contracts.js';

for (const entry of ['day', 'hover'] as const) {
  test(`${entry} recovers a retired history snapshot through app refresh without a poll or reload`, async ({ page, request }) => {
    const previous: Manifest = await (await request.get('/api/v1/manifest.json')).json();
    const date = previous.generatedAt.slice(0, 10);
    const nextAt = new Date(Math.min(Date.parse(previous.generatedAt) + 60_000, Date.parse(`${date}T23:59:59.999Z`))).toISOString();
    const elapsedMinutes = (Date.parse(nextAt) - Date.parse(previous.generatedAt)) / 60_000;
    const nextId = `${previous.snapshotId}-recovery`;
    const relocate = (path: string) => path.replace(`/snapshots/${previous.snapshotId}/`, `/snapshots/${nextId}/`);
    const next: Manifest = { ...previous, snapshotId: nextId, generatedAt: nextAt, paths: {
      ...previous.paths, summary: relocate(previous.paths.summary), search: relocate(previous.paths.search),
      recentIncidents: relocate(previous.paths.recentIncidents), health: relocate(previous.paths.health),
      providers: Object.fromEntries(Object.entries(previous.paths.providers).map(([id, path]) => [id, relocate(path)])),
    } };
    const nextFiles: Record<string, unknown> = {};
    for (const path of [previous.paths.summary, previous.paths.search, previous.paths.recentIncidents, previous.paths.providers.openai!]) {
      const value = await (await request.get(path)).json();
      value.snapshotId = nextId; value.generatedAt = nextAt;
      const providers = path === previous.paths.summary ? value.providers : path === previous.paths.providers.openai ? [value.provider] : [];
      for (const provider of providers) {
        provider.dailyCoverage30d[29].unknownMinutes += elapsedMinutes;
        if (elapsedMinutes && provider.dailyTrack30d.endsWith('0')) provider.dailyTrack30d = `${provider.dailyTrack30d.slice(0, 29)}9`;
      }
      if (value.dailyHistory30d) value.dailyHistory30d[29].unknownMinutes += elapsedMinutes;
      if (path === previous.paths.recentIncidents) {
        const event = value.incidents.find((item: { providerId: string; resolvedAt: string | null }) => item.providerId === 'openai' && !item.resolvedAt);
        event.title = 'Fixture newly published daily incident'; event.updatedAt = nextAt;
      }
      nextFiles[relocate(path)] = value; // Explicit versioned publication fixture, isolated from local data.
    }
    let published = false;
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    let retiredReads = 0;
    let oldDetails = 0;
    let navigations = 0;
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations++; });
    await page.clock.install({ time: new Date(previous.generatedAt) });
    await page.clock.pauseAt(new Date(Date.parse(previous.generatedAt) + 10_000));
    await page.route('**/api/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === previous.paths.recentIncidents) {
        retiredReads++;
        await gate;
        await route.fulfill({ status: 404, body: 'Explicit fixture: retired snapshot history' });
      } else if (published && path === '/api/v1/manifest.json') {
        await route.fulfill({ json: next });
      } else if (path === previous.paths.providers.openai) {
        oldDetails++;
        await route.continue(); // Its independent snapshot recovery must not mask the history bug.
      } else if (published && nextFiles[path] !== undefined) {
        await route.fulfill({ json: nextFiles[path] });
      } else await route.continue();
    });
    await page.goto(entry === 'day' ? `/?view=day&provider=openai&date=${date}&q=API` : '/?q=OpenAI');
    if (entry === 'day') {
      await expect(page.getByRole('heading', { level: 1 })).toContainText('OpenAI');
      await expect.poll(() => oldDetails).toBe(1);
    } else {
      await expect(page.getByTestId('provider-card')).toHaveCount(1);
      published = true;
      await page.getByRole('link', { name: new RegExp(`OpenAI.*${date}`) }).hover();
      await expect(page.getByRole('tooltip')).toContainText('正在加载已记录事件');
    }
    await expect.poll(() => retiredReads).toBe(1);
    published = true;
    release();
    if (entry === 'day') {
      await expect(page.getByTestId('incident')).toContainText('Fixture newly published daily incident');
      await expect(page.locator('.day-snapshot time')).toHaveAttribute('datetime', nextAt);
    } else {
      await expect(page.getByRole('tooltip')).toContainText('Fixture newly published daily incident');
      await expect(page.locator('.snapshot-meta time')).toHaveAttribute('datetime', nextAt);
    }
    await expect(page.getByRole('link', { name: 'Snapshot JSON ↗' })).toHaveAttribute('href', next.paths.summary);
    await expect(page.getByText('每日事件加载失败', { exact: true })).toHaveCount(0);
    expect(retiredReads).toBe(1);
    expect(navigations).toBe(1);
    expect(await page.evaluate(() => Date.now())).toBe(Date.parse(previous.generatedAt) + 10_000);
    await expect(page).toHaveURL(entry === 'day' ? /view=day.*q=API/ : /q=OpenAI/);
  });
}

test('daily header navigation clears provider and date and leaves grid and history operable', async ({ page, request }) => {
  const manifest = await (await request.get('/api/v1/manifest.json')).json();
  const date = manifest.generatedAt.slice(0, 10);
  await page.goto(`/?view=day&provider=openai&date=${date}&q=OpenAI&cat=ai`);
  await expect(page.getByTestId('incident')).toHaveCount(1);
  await page.getByRole('button', { name: /Incident Vault/ }).click();
  await expect(page).toHaveURL(/view=incidents/);
  await expect(page).not.toHaveURL(/provider=|date=/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('[inert]')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: '历史时间范围' })).toBeEnabled();
  await page.getByRole('button', { name: /Live Grid/ }).click();
  await expect(page.getByRole('searchbox')).toHaveValue('OpenAI');
  await expect(page.getByTestId('provider-card')).toHaveCount(1);
  await page.getByRole('link', { name: new RegExp(`OpenAI.*${date}`) }).click();
  await expect(page).toHaveURL(/view=day/);
  await page.getByRole('button', { name: /Live Grid/ }).click();
  await expect(page).not.toHaveURL(/view=day|provider=|date=/);
  await expect(page.locator('[inert]')).toHaveCount(0);
  await page.getByRole('button', { name: '查看 OpenAI 详情' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: '关闭详情' }).click();
  await expect(page.getByRole('searchbox')).toBeEnabled();
});

test('hover lazily loads actual day events, follows a shareable link, and restores grid context', async ({ page, request }) => {
  const manifest = await (await request.get('/api/v1/manifest.json')).json();
  const date = manifest.generatedAt.slice(0, 10);
  let historyReads = 0;
  await page.route('**/incidents/recent.json', async (route) => { historyReads++; await route.continue(); });
  await page.goto('/?cat=ai&q=OpenAI&only_abnormal=1');
  await expect(page.getByTestId('provider-card')).toHaveCount(1);
  expect(historyReads).toBe(0);
  const cell = page.getByRole('link', { name: new RegExp(`OpenAI.*${date}`) });
  await cell.hover();
  await expect(page.getByRole('tooltip')).toContainText(date);
  await expect(page.getByRole('tooltip')).toContainText('API requests experiencing elevated latency');
  await expect(cell).toHaveAttribute('href', new RegExp(`provider=openai.*date=${date}`));
  await cell.click();
  await expect(page).toHaveURL(new RegExp(`view=day.*date=${date}`));
  await expect(page.getByRole('heading', { level: 1 })).toContainText('OpenAI');
  await expect(page.getByTestId('incident')).toContainText('API requests experiencing elevated latency');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(historyReads).toBe(1);
  await page.reload();
  await expect(page.getByTestId('incident')).toHaveCount(1);
  await page.getByRole('link', { name: '返回矩阵' }).click();
  await expect(page.getByRole('searchbox')).toHaveValue('OpenAI');
  await expect(page.getByTestId('provider-card')).toHaveCount(1);
  await page.goBack();
  await expect(page.getByTestId('incident')).toHaveCount(1);
  await page.goForward();
  await expect(page.getByRole('searchbox')).toHaveValue('OpenAI');
});

test('drawer tracks support ordered keyboard navigation, Escape, and day navigation', async ({ page, request }) => {
  const manifest = await (await request.get('/api/v1/manifest.json')).json();
  const date = manifest.generatedAt.slice(0, 10);
  await page.goto('/?provider=openai');
  const track = page.getByRole('dialog').getByRole('group', { name: /近 30 天状态轨迹/ });
  await expect(track.getByRole('link')).toHaveCount(30);
  await track.getByRole('link').last().hover();
  await expect(page.getByRole('tooltip')).toContainText(date);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await track.locator('[tabindex="0"]').count()).toBe(1);
  await track.locator('[tabindex="0"]').focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await expect(track.getByRole('link').nth(1)).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('tooltip')).toContainText(date);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  await expect(page.getByTestId('incident')).toHaveCount(1);
});

test('loading stays distinct from empty records and a failed day history can be retried', async ({ page, request }) => {
  const manifest = await (await request.get('/api/v1/manifest.json')).json();
  const date = manifest.generatedAt.slice(0, 10);
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  let fail = true;
  await page.route(/\/incidents\/archive\/\d{4}-\d{2}\/[^/]+\.json$/, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), incidents: [] } });
  });
  await page.route('**/incidents/recent.json', async (route) => {
    await gate;
    if (fail) await route.fulfill({ status: 503, body: 'explicit fixture failure' });
    else {
      const response = await route.fetch();
      const recent = await response.json();
      recent.incidents = []; // Explicit empty-history fixture; summary track remains abnormal.
      await route.fulfill({ response, json: recent });
    }
  });
  await page.goto('/');
  const cell = page.getByRole('link', { name: new RegExp(`OpenAI.*${date}`) });
  await cell.hover();
  await expect(page.getByRole('tooltip')).toContainText('正在加载已记录事件');
  await expect(page.getByRole('tooltip')).not.toContainText('暂无已记录事件');
  release();
  await expect(page.getByRole('tooltip')).toContainText('事件加载失败');
  await cell.click();
  await expect(page.getByText('每日事件加载失败', { exact: true })).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByText('暂无已记录事件', { exact: true })).toBeVisible();
  await expect(page.getByText(/轨迹记录了异常，但事件详情有限/)).toBeVisible();
  await expect(page.getByText('覆盖有限 · 未观测时间不计为正常')).toBeVisible();
});

test('day links validate dates and providers and guide older days to the correct archive', async ({ page, request }) => {
  const manifest = await (await request.get('/api/v1/manifest.json')).json();
  const date = manifest.generatedAt.slice(0, 10);
  await page.goto('/?view=day&provider=openai&date=2026-02-30');
  await expect(page.getByText('日期无效', { exact: true }).last()).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goto(`/?view=day&provider=unknown&date=${date}`);
  await expect(page.getByText('未知厂商', { exact: true }).last()).toBeVisible();
  await page.goto('/?view=day&provider=openai&date=2020-01-31&q=API');
  await expect(page.getByText('日期不在当前 30 天轨迹窗口')).toBeVisible();
  await page.getByRole('link', { name: '查看此厂商月度归档 →' }).click();
  await expect(page).toHaveURL(/view=incidents/);
  await expect(page).toHaveURL(/month=2020-01/);
  await expect(page).toHaveURL(/providers=openai/);
  await expect(page).toHaveURL(/q=API/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('continuing events are included on the previous UTC day and source time bases stay explicit', async ({ page, request }) => {
  const manifest = await (await request.get('/api/v1/manifest.json')).json();
  const previous = new Date(Date.parse(`${manifest.generatedAt.slice(0, 10)}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  await page.route('**/incidents/recent.json', async (route) => {
    const response = await route.fetch();
    const recent = await response.json();
    // Explicit cross-day fixture; do not alter the actual local dataset.
    const incident = recent.incidents.find((event: { providerId: string; resolvedAt: string | null }) => event.providerId === 'openai' && !event.resolvedAt);
    incident.startedAt = `${previous}T23:00:00.000Z`;
    incident.startTimeBasis = 'source_created_at';
    await route.fulfill({ response, json: recent });
  });
  await page.goto(`/?view=day&provider=openai&date=${previous}`);
  await expect(page.getByTestId('incident')).toContainText('API requests experiencing elevated latency');
  await expect(page.getByTestId('incident')).toContainText('官方创建时间（非确认开始）');
  await expect(page.getByTestId('incident')).toContainText(previous);
});

test('a refreshed fixture day discloses its provenance and returns focus to the chosen track cell', async ({ page, request }) => {
  const manifest = await (await request.get('/api/v1/manifest.json')).json();
  const date = manifest.generatedAt.slice(0, 10);
  await page.goto(`/?view=day&provider=openai&date=${date}`);
  await expect(page.getByText('FIXTURE / 演示数据')).toBeVisible();
  await expect(page.getByText(/数据年龄/).first()).toBeVisible();
  await page.getByRole('link', { name: '返回矩阵' }).click();
  await expect(page.getByRole('link', { name: new RegExp(`OpenAI.*${date}`) })).toBeFocused();
});

test('an aged daily snapshot keeps its events and discloses that current status is unverifiable', async ({ page, request }) => {
  const manifest = await (await request.get('/api/v1/manifest.json')).json();
  const date = manifest.generatedAt.slice(0, 10);
  await page.clock.install({ time: new Date() });
  await page.goto(`/?view=day&provider=openai&date=${date}`);
  await expect(page.getByTestId('incident')).toHaveCount(1);
  await page.clock.fastForward(16 * 60_000);
  await expect(page.getByText('快照过期 · 当前状态不可验证', { exact: true })).toBeVisible();
  await expect(page.getByTestId('incident')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(date);
});

test('clicking during hover loading transfers the same history request to the daily page', async ({ page, request }) => {
  const manifest = await (await request.get('/api/v1/manifest.json')).json();
  const date = manifest.generatedAt.slice(0, 10);
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  let reads = 0;
  await page.route('**/incidents/recent.json', async (route) => {
    reads++;
    await gate;
    await route.continue();
  });
  await page.goto('/');
  const cell = page.getByRole('link', { name: new RegExp(`OpenAI.*${date}`) });
  await cell.hover();
  await expect(page.getByRole('tooltip')).toContainText('正在加载已记录事件');
  await expect.poll(() => reads).toBe(1);
  await cell.click();
  await expect(page).toHaveURL(/view=day/);
  await expect(page.getByText('正在加载已记录事件…', { exact: true })).toBeVisible();
  release();
  await expect(page.getByTestId('incident')).toHaveCount(1);
  expect(reads).toBe(1);
});

test('hover limits its titles while the daily page keeps every related incident kind and severity', async ({ page, request }) => {
  const manifest = await (await request.get('/api/v1/manifest.json')).json();
  const date = manifest.generatedAt.slice(0, 10);
  await page.route('**/incidents/recent.json', async (route) => {
    const response = await route.fetch();
    const recent = await response.json();
    const base = recent.incidents.find((event: { providerId: string; resolvedAt: string | null }) => event.providerId === 'openai' && !event.resolvedAt);
    // Explicit fixture variations preserve the public schema, with independently named events.
    recent.incidents = [
      base,
      { ...base, id: 'fixture-maintenance', title: 'Fixture planned maintenance', kind: 'maintenance', severity: 'maintenance' },
      { ...base, id: 'fixture-advisory', title: 'Fixture advisory with unknown severity', kind: 'advisory', severity: null },
      { ...base, id: 'fixture-observed', title: 'Fixture observed interruption', origin: 'observed', isSynthetic: true, startTimeBasis: 'first_observed' },
    ];
    await route.fulfill({ response, json: recent });
  });
  await page.goto('/');
  const cell = page.getByRole('link', { name: new RegExp(`OpenAI.*${date}`) });
  await cell.hover();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toContainText('4 条已记录事件');
  await expect(tooltip.locator('li')).toHaveCount(3);
  await expect(tooltip).toContainText('另有 1 条');
  await cell.click();
  await expect(page.getByTestId('incident')).toHaveCount(4);
  await expect(page.getByTestId('incident').filter({ hasText: 'Fixture advisory' })).toContainText('严重度未知');
  await expect(page.getByTestId('incident').filter({ hasText: 'Fixture observed' })).toContainText('估计开始（首次观测）');
  await expect(page.getByTestId('incident').filter({ hasText: 'Fixture planned' })).toContainText('维护');
});

test('touch opens a day directly and modified links retain native new-tab behavior', async ({ browser, baseURL, request }) => {
  const manifest = await (await request.get('/api/v1/manifest.json')).json();
  const date = manifest.generatedAt.slice(0, 10);
  const context = await browser.newContext({ baseURL, hasTouch: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await page.goto('/');
    await page.getByRole('link', { name: new RegExp(`OpenAI.*${date}`) }).tap();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('OpenAI');
    await expect(page.getByTestId('incident')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('link', { name: '返回矩阵' }).tap();
    const popupPromise = context.waitForEvent('page');
    await page.getByRole('link', { name: new RegExp(`OpenAI.*${date}`) }).click({ modifiers: ['ControlOrMeta'] });
    const popup = await popupPromise;
    await popup.waitForLoadState();
    await expect(popup).toHaveURL(/view=day/);
    await expect(page).not.toHaveURL(/view=day/);
    await expect(popup.getByTestId('incident')).toHaveCount(1);
  } finally { await context.close(); }
});

for (const width of [1440, 390]) {
  for (const theme of ['dark', 'light'] as const) {
    test(`hover and daily page remain visible in ${theme} at ${width}px`, async ({ page, request }) => {
      await page.setViewportSize({ width, height: 1050 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
      page.on('requestfailed', (request) => errors.push(`${request.url()} ${request.failure()?.errorText}`));
      const manifest = await (await request.get('/api/v1/manifest.json')).json();
      const date = manifest.generatedAt.slice(0, 10);
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      const cell = page.getByRole('link', { name: new RegExp(`OpenAI.*${date}`) });
      await cell.hover();
      const tooltip = page.getByRole('tooltip');
      await expect(tooltip).toContainText('API requests experiencing elevated latency');
      const box = await tooltip.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(1050);
      await tooltip.hover();
      await expect(tooltip).toBeVisible();
      const output = resolve('.statusgrid/screenshots/day');
      await mkdir(output, { recursive: true });
      await page.screenshot({ path: `${output}/fixture-${theme}-${width}-hover.png`, fullPage: true, animations: 'disabled' });
      await cell.click();
      await expect(page.getByTestId('incident')).toHaveCount(1);
      await expect(page.getByText('等待日统计')).toHaveCount(0);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.getByText('FIXTURE / 演示数据')).toBeVisible();
      await expect(page.getByText(/数据年龄/).first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `${output}/fixture-${theme}-${width}-day.png`, fullPage: true, animations: 'disabled' });
      expect(errors).toEqual([]);
    });
  }
}
