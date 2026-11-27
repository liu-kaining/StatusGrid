import { z } from 'zod';
import {
  text, instant, nullableTime, https, version, providerId, status, number, strings,
  publicStatusSchema, collectionSchema, coverageSchema, componentSchema, incidentSchema, dailyStatSchema,
} from './entity-schemas.js';
import { publicStatus, summarizeProviders } from './status.js';

export const modeSchema = z.enum(['live', 'fixture']);
export const revisionSchema = z.string().regex(/^[a-f0-9]{24}$/);
export const publicPathSchema = z.string().regex(/^\/(?:api\/v1|feed)\/[a-zA-Z0-9_.:/-]+$/)
  .refine((value) => !value.split('/').some((part) => part === '..' || part === '.') && !value.includes('//'), 'Unsafe public path');
export const envelopeFields = {
  schemaVersion: version, snapshotId: text, generatedAt: instant,
  intervalMinutes: z.union([z.literal(5), z.literal(10)]), dataMode: modeSchema,
};
const count = z.number().int().nonnegative();
export const providerSummarySchema = z.strictObject({
  id: providerId, name: text, category: z.enum(['ai', 'cloud-cn', 'cloud-global', 'infra']),
  status: publicStatusSchema, reportedStatus: status.nullable(), officialStatusUrl: https,
  collection: collectionSchema, coverage: coverageSchema,
  componentSummary: z.strictObject({ total: count, abnormal: count, abnormalNames: strings.max(5), affectedRegions: strings }),
  dailyTrack30d: z.string().regex(/^[012349]{30}$/),
  dailyCoverage30d: z.array(z.strictObject({ observedCoverageMinutes: number.max(1440), unknownMinutes: number.max(1440) })).length(30),
  activeIncidents: z.array(z.strictObject({
    id: text, title: text, severity: z.enum(['degraded', 'partial_outage', 'major_outage']),
    origin: z.enum(['official', 'observed']), startedAt: instant, updatedAt: instant, sourceUrl: https,
  })),
}).superRefine((provider, ctx) => {
  if (provider.status !== publicStatus(provider.reportedStatus, provider.collection.freshness)
    || provider.componentSummary.abnormal > provider.componentSummary.total
    || provider.componentSummary.abnormalNames.length > provider.componentSummary.abnormal) {
    ctx.addIssue({ code: 'custom', message: 'Inconsistent provider summary' });
  }
});
export const summarySchema = z.strictObject({
  ...envelopeFields,
  globalSummary: z.strictObject({
    overallStatus: publicStatusSchema, totalProviders: count, connectedProviders: count,
    countsByStatus: z.strictObject({ operational: count, maintenance: count, degraded: count, partial_outage: count, major_outage: count, stale: count }),
    abnormalProviderCount: count, activeIncidentCount: count, maintenanceCount: count, staleProviderCount: count,
  }),
  providers: z.array(providerSummarySchema),
}).superRefine((summary, ctx) => {
  if (new Set(summary.providers.map(({ id }) => id)).size !== summary.providers.length
    || JSON.stringify(summary.globalSummary) !== JSON.stringify(summarizeProviders(summary.providers))) {
    ctx.addIssue({ code: 'custom', message: 'Inconsistent global summary' });
  }
  const at = Date.parse(summary.generatedAt);
  for (const provider of summary.providers) {
    provider.dailyCoverage30d.forEach((day, index) => {
      const expected = index === 29 ? (at % 86_400_000) / 60_000 : 1440;
      if (Math.abs(day.observedCoverageMinutes + day.unknownMinutes - expected) > 0.000001
        || (provider.dailyTrack30d[index] === '0' && day.unknownMinutes > 0)) {
        ctx.addIssue({ code: 'custom', message: 'Inconsistent daily coverage' });
      }
    });
  }
});
export const providerDetailSchema = z.strictObject({
  ...envelopeFields, provider: providerSummarySchema,
  componentGroups: z.array(z.strictObject({ id: text, name: text, components: z.array(componentSchema) })),
  dailyHistory30d: z.array(dailyStatSchema).length(30), recentIncidents: z.array(incidentSchema), warnings: z.array(z.string()),
});
export const manifestSchema = z.strictObject({
  ...envelopeFields, archiveIndexRevision: revisionSchema,
  paths: z.strictObject({
    summary: publicPathSchema, providers: z.record(providerId, publicPathSchema),
    recentIncidents: publicPathSchema, health: publicPathSchema, search: publicPathSchema, archiveIndex: publicPathSchema,
  }),
});
export const searchSchema = z.strictObject({
  ...envelopeFields, providers: z.array(z.strictObject({
    providerId, names: strings, components: strings, regions: strings, incidentTitles: strings,
  })),
});
export const recentSchema = z.strictObject({ ...envelopeFields, incidents: z.array(incidentSchema) });
export const healthSchema = z.strictObject({
  ...envelopeFields, runId: text, durationMs: number, latestPublishedSnapshotId: text,
  providers: z.array(z.strictObject({ providerId,
    sourceType: z.enum(['statuspage-v2', 'incident-io', 'deepseek', 'flashduty', 'xai', 'opencode', 'instatus', 'google-cloud-json', 'apple-status', 'azure-status',
      'aws-cn-health', 'tencent-cloud', 'aliyun', 'baidu-cloud']), collection: collectionSchema })),
});
export const archiveIndexSchema = z.strictObject({
  schemaVersion: version, dataMode: modeSchema, revision: revisionSchema, generatedAt: nullableTime,
  months: z.array(z.strictObject({
    month: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/), revision: revisionSchema, path: publicPathSchema,
    incidentCount: count, minStartedAt: nullableTime, maxResolvedAt: nullableTime, updatedAt: instant,
  })),
});
export const archiveSchema = z.strictObject({
  schemaVersion: version, dataMode: modeSchema, month: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/),
  revision: revisionSchema, updatedAt: instant, incidents: z.array(incidentSchema),
});
