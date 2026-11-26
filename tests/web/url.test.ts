import { describe, expect, it } from 'vitest';
import { parseViewState, serializeViewState } from '../../src/web/state/url.js';

describe('shareable view state', () => {
  it('restores every grid and history parameter without dropping a legal field', () => {
    const value = '?view=incidents&cat=ai&q=API%20%E4%B8%AD%E5%9B%BD&only_abnormal=1&provider=openai&range=month&month=2026-10&severity=major_outage,degraded&providers=openai,claude';
    const state = parseViewState(value);
    expect(state).toEqual({ view: 'incidents', category: 'ai', query: 'API 中国', onlyAbnormal: true,
      provider: 'openai', date: '', range: 'month', month: '2026-10', severity: ['degraded', 'major_outage'], providers: ['openai', 'claude'] });
    expect(parseViewState(serializeViewState(state))).toEqual(state);
  });

  it('shares a day and preserves filters without correcting an invalid date to today', () => {
    const state = parseViewState('?view=day&provider=cloudflare&date=2026-11-26&q=API');
    expect(state).toMatchObject({ view: 'day', provider: 'cloudflare', date: '2026-11-26', query: 'API' });
    expect(parseViewState(serializeViewState(state))).toEqual(state);
    expect(parseViewState('?view=day&date=2026-02-30')).toMatchObject({ view: 'day', date: '' });
  });

  it('uses safe defaults for invalid values while preserving legal filters', () => {
    const state = parseViewState('?view=bad&cat=ai&range=forever&month=2026-13&provider=../evil&only_abnormal=true&severity=evil,degraded&providers=openai,../x');
    expect(state).toMatchObject({ view: 'grid', category: 'ai', range: '30d', month: '', provider: '',
      onlyAbnormal: false, severity: ['degraded'], providers: ['openai'] });
    expect(serializeViewState(parseViewState(''))).toBe('');
  });
});
