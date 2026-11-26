import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { HealthTrack } from '../../src/web/components/HealthTrack.js';
import { webFixture } from '../helpers/web-fixture.js';

it('keeps exact UTC dates and observed/unknown minutes for full, partial-abnormal and unknown days', () => {
  const fixture = webFixture();
  const provider = structuredClone(fixture.summary.providers[0]!);
  provider.dailyTrack30d = `012349${'9'.repeat(24)}`;
  provider.dailyCoverage30d[0] = { observedCoverageMinutes: 1440, unknownMinutes: 0 };
  provider.dailyCoverage30d[2] = { observedCoverageMinutes: 900, unknownMinutes: 540 };
  const markup = renderToStaticMarkup(createElement(HealthTrack, { provider, generatedAt: fixture.summary.generatedAt }));
  expect(markup).toContain('2026-10-28 UTC · 运行正常 · 已观测 1440 分钟 / 未知 0 分钟');
  expect(markup).toContain('2026-10-30 UTC · 性能下降 · 已观测 900 分钟 / 未知 540 分钟');
  expect(markup).toContain('2026-11-02 UTC · 数据不足 · 已观测 0 分钟 / 未知 1440 分钟');
  expect(markup).toContain('底部纹理表示存在未观测时间');
  expect((markup.match(/href=/g) ?? [])).toHaveLength(30);
  expect((markup.match(/tabindex="0"/g) ?? [])).toHaveLength(1);
});

it('never describes an unknown track as healthy', () => {
  const fixture = webFixture();
  const provider = structuredClone(fixture.summary.providers[0]!);
  provider.dailyTrack30d = '9'.repeat(30);
  const markup = renderToStaticMarkup(createElement(HealthTrack, { provider, generatedAt: fixture.summary.generatedAt }));
  expect(markup).not.toContain('运行正常');
  expect(markup).toContain('数据不足');
});
