import { describe, expect, it } from 'vitest';
import type { AdapterContext, ProviderConfig } from '../../src/shared/contracts.js';
import { parseInstatus, instatusAdapter } from '../../src/collector/adapters/instatus.js';
import { TransportError } from '../../src/collector/errors.js';
import { validateAdapterResult } from '../../src/collector/storage/validate.js';
import current from '../fixtures/instatus/zed.json';
import history from '../fixtures/instatus/zed-history.json';

const now = '2026-11-27T08:00:00.000Z';
const config: ProviderConfig = {
  id: 'zed', name: 'Zed', category: 'ai', aliases: [], tags: ['ai', 'developer'],
  officialStatusUrl: 'https://status.zed.dev/', officialHomeUrl: 'https://zed.dev/',
  displayOrder: 20, enabled: true, adapter: {
    type: 'instatus', sourcePageId: 'cltn6mqey3916b6oq33ekdu7m',
    endpoints: { page: 'https://status.zed.dev/', history: 'https://status.zed.dev/history' },
    timeoutMs: 8000, retries: 2, requiredRegions: [], componentGroups: [], browserFallback: false,
  },
};
function flight(properties: unknown, textRecords: Record<string, string> = {}, recordsAfter = false): string {
  const css = '/* 元素 */\nbody {\n  color: black;\n}';
  const texts = Object.entries(textRecords).map(([id, value]) => `${id}:T${Buffer.byteLength(value).toString(16)},${value}`).join('');
  const json = `31:${JSON.stringify(['$', '$L1', null, { children: ['$', '$L2', null, properties] }])}\n`;
  const stream = `22:T${Buffer.byteLength(css).toString(16)},${css}${recordsAfter ? json + texts : texts + json}`;
  return `<script>self.__next_f.push([1,${JSON.stringify(stream)}])</script>`;
}
const native = history.monthlyGroupedNotices[1]!.notices[0]!;
function activeIncident() {
  return { ...structuredClone(native), status: 'IDENTIFIED', resolved: null,
    updates: [structuredClone(native.updates[2]!)] };
}
function context(getText: AdapterContext['http']['getText']): AdapterContext {
  return { now, signal: new AbortController().signal,
    http: { getText, getJson: async () => { throw new Error('Unexpected JSON'); },
      getResponse: async () => { throw new Error('Unexpected response'); } },
    browser: { collect: async () => [], close: async () => {} } };
}

describe('Instatus official page source', () => {
  it('reads the complete real Zed directory with native group labels and explicit active coverage', () => {
    const result = validateAdapterResult(parseInstatus(config, flight(current), null, now), 'zed');
    expect(result.reportedStatus).toBe('operational');
    expect(result.components).toHaveLength(7);
    expect(result.components.find(({ name }) => name === 'Delta Cloud Services')).toMatchObject({
      id: 'zed:cmu1vrtvz01lq1flr9ot7rwe6', groupId: 'zed:cmu1vrlrz01j21bmg0alng563',
    });
    expect(result.evidence.currentIncidentIds).toEqual([]);
    expect(result.coverage).toMatchObject({ currentState: 'complete', history: 'none' });
  });

  it('imports real native history with final resolution and chronological updates', () => {
    const result = parseInstatus(config, flight(current), flight(history), now);
    expect(result.coverage.history).toBe('native');
    expect(result.incidents[0]).toMatchObject({
      sourceIdentity: 'zed:cmvtpvng601jl1mpbu4j9lh0g', state: 'resolved', severity: 'major_outage',
      startedAt: '2026-10-29T15:00:00.000Z', resolvedAt: '2026-10-29T16:01:38.780Z',
      durationMinutes: 61.64633333333333,
      sourceUrl: 'https://status.zed.dev/incident/cmvtpvng601jl1mpbu4j9lh0g',
      affectedComponentIds: ['zed:cmu1vrtvz01lq1flr9ot7rwe6'],
    });
    expect(result.incidents[0]?.updates.map(({ phase }) => phase))
      .toEqual(['identified', 'resolved', 'identified', 'resolved']);
    expect(result.reportedStatus).toBe('operational');
  });

  it.each([false, true])('resolves long multibyte Flight message references, including forward records: %s', (recordsAfter) => {
    const message = '服务恢复说明： '.repeat(140) + '\nThe final line keeps its whitespace.  ';
    const copy = structuredClone(history);
    copy.monthlyGroupedNotices[1]!.notices[0]!.updates[3]!.message.default = '$42';
    const result = parseInstatus(config, flight(current), flight(copy, { '42': message }, recordsAfter), now);
    expect(result.coverage.history).toBe('native');
    expect(result.incidents[0]?.updates.at(-1)?.body).toBe(message);
  });

  it('decodes escaped Flight dollar strings without treating their contents as references', () => {
    const copy = structuredClone(history);
    copy.monthlyGroupedNotices[1]!.notices[0]!.updates[3]!.message.default = '$$42';
    const result = parseInstatus(config, flight(current), flight(copy), now);
    expect(result.incidents[0]?.updates.at(-1)?.body).toBe('$42');
  });

  it('rejects missing current text references and reports optional history text failures as partial coverage', () => {
    const broken = activeIncident();
    broken.updates[0]!.message.default = '$42';
    expect(() => parseInstatus(config, flight({ ...current, activeIncidents: [broken] }), null, now))
      .toThrowError(expect.objectContaining({ reason: 'invalid_payload' }));
    const copy = structuredClone(history);
    copy.monthlyGroupedNotices[1]!.notices[0]!.updates[3]!.message.default = '$42';
    const result = parseInstatus(config, flight(current), flight(copy), now);
    expect(result.coverage).toMatchObject({ currentState: 'complete', history: 'none' });
    expect(result.evidence.historyError).toBe('invalid_payload');
    expect(result.incidents).toEqual([]);
  });

  it('uses constructed active impact even when page summary and components are less severe', () => {
    const result = parseInstatus(config, flight({ ...current, activeIncidents: [activeIncident()] }), flight(history), now);
    expect(result.reportedStatus).toBe('major_outage');
    expect(result.evidence.currentIncidentIds).toEqual(['zed:cmvtpvng601jl1mpbu4j9lh0g']);
    expect(result.incidents).toHaveLength(1);
    expect(result.incidents[0]).toMatchObject({ state: 'identified', resolvedAt: null });
  });

  it.each([
    { change: { activeIncidents: undefined }, reason: 'coverage_incomplete' },
    { change: { activeMaintenances: undefined }, reason: 'coverage_incomplete' },
    { change: { activeGenericNotices: [{}] }, reason: 'coverage_incomplete' },
    { change: { site: { ...current.site, id: 'wrong' } }, reason: 'coverage_incomplete' },
    { change: { site: { ...current.site, customDomain: 'wrong.example' } }, reason: 'coverage_incomplete' },
    { change: { site: { ...current.site, components: [] } }, reason: 'coverage_incomplete' },
    { change: { site: { ...current.site, status: 'FUTURE_STATUS' } }, reason: 'unknown_status' },
    { change: { activeIncidents: [{ ...activeIncident(), status: 'FUTURE_STATUS' }] }, reason: 'unknown_status' },
    { change: { activeIncidents: [{ ...activeIncident(), resolved: native.resolved }] }, reason: 'coverage_incomplete' },
  ])('rejects constructed invalid current evidence: $reason', ({ change, reason }) => {
    expect(() => parseInstatus(config, flight({ ...current, ...change }), null, now))
      .toThrowError(expect.objectContaining({ reason }));
  });

  it('rejects unknown or duplicate component state instead of reporting green', () => {
    const copy = structuredClone(current);
    copy.site.components[0]!.status = 'FUTURE_STATUS';
    expect(() => parseInstatus(config, flight(copy), null, now))
      .toThrowError(expect.objectContaining({ reason: 'unknown_status' }));
    copy.site.components[0]!.status = 'OPERATIONAL';
    copy.site.components.push(copy.site.components[0]!);
    expect(() => parseInstatus(config, flight(copy), null, now))
      .toThrowError(expect.objectContaining({ reason: 'coverage_incomplete' }));
  });

  it('maps constructed maintenance lifecycle without treating a planned end as actual recovery', () => {
    const maintenance = { id: 'constructed-maintenance', name: { default: 'Constructed maintenance' },
      start: '2026-11-27T07:00:00.000Z', end: '2026-11-27T09:00:00.000Z',
      status: 'INPROGRESS', components: [{ id: current.site.components[0]!.id }],
      updates: [{ id: 'constructed-update', status: 'INPROGRESS',
        message: { default: 'Working' }, started: '2026-11-27T07:00:00.000Z' }] };
    const output = parseInstatus(config, flight({ ...current, activeMaintenances: [maintenance] }), null, now);
    expect(output.reportedStatus).toBe('maintenance');
    expect(output.incidents[0]).toMatchObject({
      kind: 'maintenance', state: 'in_progress', resolvedAt: null, severity: 'maintenance',
      sourceUrl: 'https://status.zed.dev/maintenance/constructed-maintenance',
    });
    const scheduled = { ...maintenance, status: 'NOTSTARTEDYET', start: '2026-11-28T07:00:00.000Z',
      updates: [{ ...maintenance.updates[0]!, status: 'NOTSTARTEDYET' }] };
    expect(parseInstatus(config, flight({ ...current, activeMaintenances: [scheduled] }), null, now).reportedStatus)
      .toBe('operational');
  });

  it('retains complete current state when optional history is malformed or belongs to another page', () => {
    for (const input of ['<html/>', flight({ ...history, site: { ...history.site, id: 'wrong' } })]) {
      const result = parseInstatus(config, flight(current), input, now);
      expect(result.coverage).toMatchObject({ currentState: 'complete', history: 'none' });
      expect(result.evidence.historyError).toBe('coverage_incomplete');
    }
  });

  it('requires actual current properties rather than accepting an empty script shell', () => {
    expect(() => parseInstatus(config, '<html><p>Operational</p></html>', null, now))
      .toThrowError(expect.objectContaining({ reason: 'coverage_incomplete' }));
    expect(() => parseInstatus(config, flight(current) + flight({ ...current, activeIncidents: [{}] }), null, now))
      .toThrowError(expect.objectContaining({ reason: 'coverage_incomplete' }));
  });

  it('fetches configured official pages and retains verified current data when history times out', async () => {
    const output = await instatusAdapter.collect(config, context(async (url) => {
      if (url === config.adapter.endpoints.page) return flight(current);
      throw new TransportError('timeout', 'History unavailable');
    }));
    expect(output.coverage.currentState).toBe('complete');
    expect(output.evidence.historyError).toBe('timeout');
    expect(output.reportedStatus).toBe('operational');
  });
});
