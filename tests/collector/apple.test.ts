import { describe, expect, it } from 'vitest';
import registry from '../../registry/providers.json';
import sample from '../fixtures/apple/current.json';
import { parseRegistry } from '../../src/shared/schemas.js';
import { parseApple } from '../../src/collector/adapters/apple.js';

const config = parseRegistry(registry).find(({ id }) => id === 'apple-cn')!;
const now = '2026-11-25T16:20:00Z';
describe('Apple system status', () => {
  it('rejects reversed resolved event intervals in the common source factory', () => {
    const reversed = { ...sample, services: [{ ...sample.services[1]!, events: [{
      ...sample.services[1]!.events[0]!, eventStatus: 'resolved', epochEndDate: 1795629500000,
    }] }] };
    expect(() => parseApple(config, JSON.stringify(reversed), now))
      .toThrowError(expect.objectContaining({ reason: 'invalid_payload' }));
  });
  it('parses JSON and one anchored JSONP wrapper with active events', () => {
    const result = parseApple(config, JSON.stringify(sample), now);
    expect(result.components).toHaveLength(2);
    expect(result.reportedStatus).toBe('major_outage');
    expect(result.incidents[0]).toMatchObject({ state: 'investigating', resolvedAt: null });
    expect(parseApple(config, `callback.status(${JSON.stringify(sample)});`, now).reportedStatus).toBe('major_outage');
  });
  it('does not execute malformed JSONP or trailing code', () => {
    expect(() => parseApple(config, `callback(${JSON.stringify(sample)});globalThis.exploited=true`, now)).toThrow();
    expect(() => parseApple(config, `callback[0](${JSON.stringify(sample)})`, now)).toThrow();
    expect((globalThis as { exploited?: boolean }).exploited).toBeUndefined();
  });
  it('retains resolved event history and never infers a present outage', () => {
    const ended = { ...sample, services: [{ ...sample.services[1]!, events: [{ ...sample.services[1]!.events[0]!, eventStatus: 'resolved', epochEndDate: 1795630000000 }] }] };
    const result = parseApple(config, JSON.stringify(ended), now);
    expect(result.reportedStatus).toBe('operational');
    expect(result.incidents[0]?.resolvedAt).not.toBeNull();
  });
  it('requires a nonempty service directory and known lifecycle', () => {
    expect(() => parseApple(config, '{"services":[]}', now)).toThrowError(expect.objectContaining({ reason: 'coverage_incomplete' }));
    expect(() => parseApple(config, JSON.stringify({ ...sample, services: [{ serviceName: 'X' }] }), now))
      .toThrowError(expect.objectContaining({ reason: 'invalid_payload' }));
  });
  it('preserves service IDs when Apple changes listing order', () => {
    const original = parseApple(config, JSON.stringify(sample), now);
    const reordered = parseApple(config, JSON.stringify({ ...sample, services: [...sample.services].reverse() }), now);
    expect(original.components.find(({ name }) => name === 'iCloud')?.id)
      .toBe(reordered.components.find(({ name }) => name === 'iCloud')?.id);
  });
});
