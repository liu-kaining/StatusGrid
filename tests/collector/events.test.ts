import { describe, expect, it } from 'vitest';
import { emptyState } from '../../src/collector/events/reconcile.js';
import { advance, run, source, time } from '../helpers/history.js';

describe('persisted lifecycle reconciliation', () => {
  it('preserves an observed fault through failure, escalates once, and resolves only on complete scope recovery', () => {
    let state = advance(emptyState(), run(time(0), 'operational'));
    state = advance(state, run(time(5), 'degraded'));
    const id = state.incidents[0]!.id;
    state = advance(state, run(time(10), 'major_outage'));
    state = advance(state, run(time(15), null));
    expect(state.openIncidents).toHaveLength(1);
    expect(state.openIncidents[0]!.resolvedAt).toBeNull();
    expect(state.ledger.milestones.map(({ id }) => id)).toEqual([`${id}:triggered`, `${id}:escalated:${id}:update:${time(10)}`]);
    state = advance(state, run(time(20), 'operational'));
    expect(state.openIncidents).toEqual([]);
    expect(state.incidents[0]).toMatchObject({ id, origin: 'observed', resolvedAt: time(20), durationMinutes: 15 });
    expect(state.ledger.milestones.at(-1)?.id).toBe(`${id}:resolved`);
    expect(advance(state, run(time(20), 'operational'))).toEqual(state);
  });

  it('keeps disappeared official incidents unresolved and stores verified current IDs separately', () => {
    const state = advance(advance(emptyState(), run(time(0), 'degraded', [source()])), run(time(5), 'operational', [], []));
    expect(state.openIncidents).toHaveLength(1);
    expect(state.incidents[0]?.resolvedAt).toBeNull();
    expect(state.latest?.providers[0]?.result?.evidence.currentIncidentIds).toEqual([]);
    expect(state.ledger.milestones).toHaveLength(1);
  });

  it('reopens reused official IDs with an isolated episode after the recovery gap', () => {
    let state = advance(emptyState(), run(time(0), 'degraded', [source()]));
    const resolved = source({ state: 'resolved', resolvedAt: time(5), resolvedTimeBasis: 'source',
      updatedAt: time(5), updates: [{ id: 'resolved', phase: 'resolved', body: 'Fixed', timestamp: time(5) }] });
    state = advance(state, run(time(5), 'operational', [resolved], []));
    state = advance(state, run(time(20), 'degraded', [source({
      updatedAt: time(20), updates: [...resolved.updates, { id: 'again', phase: 'investigating', body: '<b>Again</b>', timestamp: time(15) }],
    })]));
    expect(state.incidents.map(({ episode, startedAt, resolvedAt, updates }) =>
      ({ episode, startedAt, resolvedAt, updates: updates.map(({ id }) => id) }))).toEqual([
      { episode: 1, startedAt: time(0), resolvedAt: time(5), updates: ['resolved'] },
      { episode: 2, startedAt: time(15), resolvedAt: null, updates: ['again'] },
    ]);
    expect(state.incidents[1]).toMatchObject({ startTimeBasis: 'source_reopened_at', durationMinutes: null });
    expect(state.identities['github:native']?.latestEpisode).toBe(2);
    expect(state.ledger.milestones).toHaveLength(3);
  });

  it('uses first observation when a reused thread has no reliable new active timestamp', () => {
    let state = advance(emptyState(), run(time(5), 'operational', [source({
      state: 'resolved', resolvedAt: time(5), resolvedTimeBasis: 'source', updatedAt: time(5),
    })], []));
    state = advance(state, run(time(20), 'degraded', [source({ updatedAt: time(20) })]));
    expect(state.incidents.at(-1)).toMatchObject({ episode: 2, startedAt: time(20), startTimeBasis: 'first_observed', updates: [] });
  });

  it('aliases overlapping synthetic evidence to native scope without a second trigger', () => {
    let state = advance(emptyState(), run(time(5), 'degraded'));
    const observedId = state.incidents[0]!.id;
    state = advance(state, run(time(10), 'degraded', [source()]));
    const official = state.incidents.find(({ origin }) => origin === 'official')!;
    expect(state.incidents.find(({ id }) => id === observedId)?.supersededBy).toBe(official.id);
    expect(state.openIncidents.map(({ id }) => id)).toEqual([official.id]);
    expect(state.ledger.aliases[official.id]).toBe(observedId);
    expect(state.ledger.milestones.filter(({ kind }) => kind === 'triggered')).toHaveLength(1);
  });

  it('keeps one observed availability fault across repeated null-severity native evidence', () => {
    let state = advance(emptyState(), run(time(0), 'degraded'));
    const observedId = state.incidents[0]!.id;
    for (const minute of [5, 10, 15]) {
      state = advance(state, run(time(minute), 'degraded', [
        source({ severity: null, severityBasis: 'unknown', updatedAt: time(minute) }),
      ]));
      expect(state.incidents).toHaveLength(2);
      expect(state.incidents.filter(({ isSynthetic }) => isSynthetic)).toHaveLength(1);
      expect(state.incidents.find(({ id }) => id === observedId)?.supersededBy).toBeNull();
      expect(state.ledger.aliases).toEqual({});
      expect(state.ledger.milestones.map(({ id }) => id)).toEqual([`${observedId}:triggered`]);
    }
  });

  it('preserves an escalation when verified current native impact replaces observed degradation', () => {
    let state = advance(emptyState(), run(time(0), 'degraded'));
    const observedId = state.incidents[0]!.id;
    const native = source({
      severity: 'major_outage', state: 'unknown', updatedAt: time(5),
      updates: [{ id: 'official-escalation', phase: 'unknown', body: 'Major impact confirmed', timestamp: time(5) }],
    });
    state = advance(state, run(time(5), 'major_outage', [native]));
    expect(state.openIncidents).toHaveLength(1);
    expect(state.openIncidents[0]?.origin).toBe('official');
    expect(state.ledger.milestones.map(({ id }) => id)).toEqual([
      `${observedId}:triggered`, `${observedId}:escalated:official-escalation`,
    ]);
    state = advance(state, run(time(10), 'major_outage', [native]));
    expect(state.ledger.milestones.map(({ kind }) => kind)).toEqual(['triggered', 'escalated']);
  });

  it('does not turn advisories or finite historical candidates into availability faults', () => {
    const advisory = source({ kind: 'advisory', state: 'unknown', severity: null });
    const state = advance(emptyState(), run(time(10), 'operational', [advisory], [advisory.sourceIdentity]));
    expect(state.incidents).toHaveLength(1);
    expect(state.incidents[0]?.isSynthetic).toBe(false);
    expect(state.ledger.milestones).toEqual([]);
    expect(advance(emptyState(), run(time(10), null)).incidents).toEqual([]);
  });

  it('recognizes verified current official impact even when its lifecycle phase is unknown', () => {
    const state = advance(emptyState(), run(time(0), 'partial_outage', [
      source({ state: 'unknown', severity: 'partial_outage', severityBasis: 'component' }),
    ]));
    expect(state.incidents).toHaveLength(1);
    expect(state.incidents[0]?.origin).toBe('official');
    expect(state.ledger.milestones.map(({ kind }) => kind)).toEqual(['triggered']);
  });

  it('does not overwrite a reopened episode with late corrections or retain the old episode resolved_at', () => {
    let state = advance(emptyState(), run(time(5), 'operational', [source({
      state: 'resolved', resolvedAt: time(5), resolvedTimeBasis: 'source', updatedAt: time(5),
    })], []));
    state = advance(state, run(time(20), 'degraded', [source({
      updatedAt: time(20), resolvedAt: time(5), resolvedTimeBasis: 'source',
      updates: [{ id: 'new', phase: 'investigating', body: 'Again', timestamp: time(15) }],
    })]));
    state = advance(state, run(time(25), 'degraded', [source({
      updatedAt: time(25), resolvedAt: time(5), resolvedTimeBasis: 'source',
      updates: [{ id: 'new', phase: 'investigating', body: 'Again', timestamp: time(15) }],
    })]));
    expect(state.incidents.at(-1)).toMatchObject({ episode: 2, resolvedAt: null, startedAt: time(15) });
    state = advance(state, run(time(30), 'operational', [source({
      state: 'resolved', updatedAt: time(30), resolvedAt: time(6), resolvedTimeBasis: 'source',
      postmortemUrl: 'https://www.githubstatus.com/review',
    })], []));
    expect(state.incidents[0]).toMatchObject({ episode: 1, resolvedAt: time(6), postmortemUrl: 'https://www.githubstatus.com/review' });
    expect(state.incidents[1]).toMatchObject({ episode: 2, resolvedAt: null });
  });

  it('keeps unmatched broader observed scope when a native event covers only a subset', () => {
    const first = run(time(5), 'degraded');
    first.providers[0]!.result!.components = [];
    let state = advance(emptyState(), first);
    const next = run(time(10), 'degraded', [source()]);
    next.providers[0]!.result!.components = [];
    state = advance(state, next);
    expect(state.openIncidents).toHaveLength(2);
    expect(state.incidents.find(({ isSynthetic }) => isSynthetic)?.supersededBy).toBeNull();
    expect(state.ledger.aliases).toEqual({});
  });

  it('recovers component scopes independently and starts a new observed identity after recovery', () => {
    const first = run(time(0), 'degraded');
    first.providers[0]!.result!.components.push({ ...first.providers[0]!.result!.components[0]!, id: 'github:other', name: 'Other' });
    let state = advance(emptyState(), first);
    expect(state.openIncidents).toHaveLength(2);
    const partialRecovery = run(time(5), 'degraded');
    partialRecovery.providers[0]!.result!.components = [
      { ...first.providers[0]!.result!.components[0]!, reportedStatus: 'operational' },
      first.providers[0]!.result!.components[1]!,
    ];
    state = advance(state, partialRecovery);
    expect(state.openIncidents.map(({ affectedComponentIds }) => affectedComponentIds)).toEqual([['github:other']]);
    state = advance(state, run(time(10), 'degraded'));
    expect(state.incidents.filter(({ affectedComponentIds }) => affectedComponentIds.includes('github:api'))).toHaveLength(2);
  });
});
