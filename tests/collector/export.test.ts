import { describe, expect, it } from 'vitest';
import { buildPublicArtifacts } from '../../src/collector/export/json.js';
import { summarySchema, providerDetailSchema, archiveIndexSchema } from '../../src/shared/public-schemas.js';
import { emptyState } from '../../src/collector/events/reconcile.js';
import { advance, run, source, time } from '../helpers/history.js';
import registry from '../../registry/providers.json';
import awsCatalog from '../fixtures/aws-cn/services.json';
import awsUnscopedCatalog from '../fixtures/aws-cn/services-unscoped.json';
import { parseRegistry } from '../../src/shared/schemas.js';
import { parseAwsChina } from '../../src/collector/adapters/aws-cn.js';

describe('public JSON and search', () => {
  it('exports and indexes AWS catalog services with unspecified geography as null components', () => {
    const config = parseRegistry(registry).find(({ id }) => id === 'aws-cn')!;
    const result = parseAwsChina(config, [], time(0), [...awsCatalog, ...awsUnscopedCatalog]);
    const collection = run(time(0), 'operational');
    collection.providers[0] = { ...collection.providers[0]!, providerId: 'aws-cn',
      officialStatusUrl: config.officialStatusUrl, result, lastTrustedResult: result };
    const output = buildPublicArtifacts(collection, advance(emptyState(), collection));
    const detail = providerDetailSchema.parse(output.details['aws-cn']);
    const components = detail.componentGroups.flatMap(({ components }) => components);
    expect(components).toHaveLength(5);
    expect(components.find(({ id }) => id === 'aws-cn:health')?.region).toBeNull();
    expect(components.find(({ id }) => id === 'aws-cn:iam')?.region).toBeNull();
    expect(output.search.providers[0]?.components).toContain('Amazon Health');
    expect(output.search.providers[0]?.components).toContain('Amazon Identity and Access Management');
    expect(output.search.providers[0]?.regions).toEqual(['cn-north-1', 'cn-northwest-1']);
    expect(output.summary.providers[0]?.componentSummary.total).toBe(5);
  });

  it('uses null for an empty immutable index watermark and keeps it stable across snapshots', () => {
    const firstRun = run(time(0), 'operational');
    const firstState = advance(emptyState(), firstRun);
    const first = buildPublicArtifacts(firstRun, firstState);
    const nextRun = run(time(5), 'operational');
    const next = buildPublicArtifacts(nextRun, advance(firstState, nextRun));
    expect(first.archiveIndex.generatedAt).toBeNull();
    expect(archiveIndexSchema.parse(first.archiveIndex).generatedAt).toBeNull();
    expect(next.archiveIndex).toEqual(first.archiveIndex);
    expect(next.manifest.generatedAt).toBe(time(5));
    expect(firstState.latest?.completedAt).toBe(time(0));
  });

  it('uses the newest referenced month watermark rather than the hot publication clock', () => {
    const closed = source({ state: 'resolved', resolvedAt: time(5), resolvedTimeBasis: 'source', updatedAt: time(5) });
    const oldRun = run(time(5), 'operational', [closed], []);
    const state = advance(emptyState(), oldRun);
    const current = run(time(10), 'operational');
    const output = buildPublicArtifacts(current, advance(state, current));
    expect(output.archiveIndex.generatedAt).toBe(time(5));
    expect(output.manifest.generatedAt).toBe(time(10));
    expect(output.archiveIndex.months).toHaveLength(1);
  });

  it('publishes consistent envelopes, literal unknown days and independently consumable detail', () => {
    const collection = run(time(0), 'operational');
    const state = advance(emptyState(), collection);
    const artifacts = buildPublicArtifacts(collection, state);
    const summary = summarySchema.parse(artifacts.files['api/v1/summary.json']);
    const detail = providerDetailSchema.parse(artifacts.files['api/v1/providers/github.json']);
    expect(summary.snapshotId).toBe(time(0));
    expect(summary.dataMode).toBe('live');
    expect(summary.providers[0]?.dailyTrack30d).toBe('9'.repeat(30));
    expect(summary.providers[0]?.dailyCoverage30d).toHaveLength(30);
    expect(summary.providers[0]?.dailyCoverage30d[0]).toEqual({ observedCoverageMinutes: 0, unknownMinutes: 1440 });
    expect(summary.providers[0]?.dailyCoverage30d.at(-1)).toEqual({ observedCoverageMinutes: 0, unknownMinutes: 720 });
    expect(detail.provider).toEqual(summary.providers[0]);
    expect(detail.dailyHistory30d).toHaveLength(30);
    expect(artifacts.manifest.paths.summary).toContain('/snapshots/');
    expect(artifacts.files[artifacts.manifest.paths.summary.slice(1)]).toEqual(summary);
    expect(() => summarySchema.parse({ ...summary, providers: [{ ...summary.providers[0], dailyTrack30d: '0' }] })).toThrow();
    expect(() => summarySchema.parse({ ...summary, providers: [{ ...summary.providers[0], dailyCoverage30d: [] }] })).toThrow();
    expect(() => providerDetailSchema.parse({ ...detail, recentIncidents: [{ id: 'fake' }] })).toThrow();
  });

  it('retains missing coverage for known abnormal days without inventing complete healthy days', () => {
    const collection = run(time(5), 'degraded', [source()]);
    const artifacts = buildPublicArtifacts(collection, advance(emptyState(), collection));
    const provider = artifacts.summary.providers[0]!;
    expect(provider.dailyTrack30d).toBe(`${'9'.repeat(29)}2`);
    expect(provider.dailyCoverage30d.at(-1)).toEqual({ observedCoverageMinutes: 0, unknownMinutes: 725 });
    const invalid = structuredClone(artifacts.summary);
    invalid.providers[0]!.dailyCoverage30d[0]!.unknownMinutes = 0;
    expect(() => summarySchema.parse(invalid)).toThrow();
  });

  it('does not promote retained unresolved history, advisories, future maintenance or duplicates into active faults', () => {
    let state = advance(emptyState(), run(time(0), 'degraded', [source()]));
    const collection = run(time(5), 'operational', [
      source({ sourceIdentity: 'github:advice', kind: 'advisory', severity: null }),
      source({ sourceIdentity: 'github:future', kind: 'maintenance', severity: 'maintenance',
        state: 'scheduled', startedAt: '2026-11-26T00:00:00.000Z' }),
    ], []);
    state = advance(state, collection);
    expect(state.openIncidents.length).toBeGreaterThan(0);
    const artifacts = buildPublicArtifacts(collection, state);
    expect(artifacts.summary.globalSummary.activeIncidentCount).toBe(0);
    expect(artifacts.summary.globalSummary.maintenanceCount).toBe(0);
  });

  it('includes verified unknown-phase availability faults and preserves stale trusted content', () => {
    const collection = run(time(0), 'degraded', [source({ state: 'unknown' })]);
    const state = advance(emptyState(), collection);
    const artifacts = buildPublicArtifacts(collection, state);
    expect(artifacts.summary.providers[0]?.activeIncidents).toHaveLength(1);
    const failed = run(time(5), null);
    failed.providers[0]!.lastTrustedResult = collection.providers[0]!.result;
    failed.providers[0]!.collection.freshness = 'stale';
    const stale = buildPublicArtifacts(failed, advance(state, failed)).summary.providers[0]!;
    expect(stale.status).toBe('stale');
    expect(stale.reportedStatus).toBe('degraded');
    expect(stale.componentSummary.total).toBe(1);
    expect(stale.activeIncidents).toHaveLength(1);
    const firstFailure = run(time(0), null);
    const missing = buildPublicArtifacts(firstFailure, advance(emptyState(), firstFailure)).summary.providers[0]!;
    expect(missing.reportedStatus).toBeNull();
    expect(missing.activeIncidents).toEqual([]);
    expect(missing.dailyTrack30d).toBe('9'.repeat(30));
  });

  it('indexes collapsed components and bounds abnormal names with the full count', () => {
    const collection = run(time(0), 'degraded');
    collection.providers[0]!.result!.components = Array.from({ length: 20 }, (_, index) => ({
      id: `github:${index}`, upstreamId: String(index), groupId: 'github:new-group',
      name: `Service ${index}`, aliases: [`Alias ${index}`], region: 'global',
      reportedStatus: 'degraded', displayCollapsed: true,
    }));
    const artifacts = buildPublicArtifacts(collection, advance(emptyState(), collection));
    expect(artifacts.summary.providers[0]?.componentSummary.abnormal).toBe(20);
    expect(artifacts.summary.providers[0]?.componentSummary.abnormalNames.length).toBeLessThan(20);
    expect(artifacts.search.providers[0]?.components).toContain('Service 19');
    expect(artifacts.search.providers[0]?.components).toContain('Alias 19');
    expect(artifacts.details.github?.componentGroups[0]?.name).toContain('new-group');
    expect(artifacts.details.github?.componentGroups[0]?.components).toHaveLength(20);
  });

  it('preserves distinct OpenAI native groups with verified labels and an honest fallback', () => {
    const collection = run(time(0), 'operational');
    const provider = collection.providers[0]!;
    provider.providerId = 'openai';
    provider.result!.providerId = 'openai';
    provider.result!.components = ['01K5H8S53SY1KMS4GQMNMQM1K5', '01K5H8S53SY1KMS4GQMNMZXTR1', 'new'].map((group) => ({
      id: `openai:${group}:api`, upstreamId: group, groupId: `openai:${group}`,
      name: 'API', aliases: [], region: null, reportedStatus: 'operational',
    }));
    const groups = buildPublicArtifacts(collection, advance(emptyState(), collection)).details.openai!.componentGroups;
    expect(groups.map(({ name }) => name)).toEqual(['APIs', 'ChatGPT', 'openai:new']);
    expect(new Set(groups.map(({ id }) => id)).size).toBe(3);
  });
});
