import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { z } from 'zod';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import registry from '../../../registry/providers.json';
import type { Manifest } from '../../shared/contracts.js';
import {
  archiveIndexSchema, archiveSchema, healthSchema, manifestSchema, providerDetailSchema,
  recentSchema, searchSchema, summarySchema,
} from '../../shared/public-schemas.js';
import { inventory, safeDirectory } from '../storage/directory.js';
import { revisionOf } from '../storage/archive.js';
import { STATUS_SEVERITY } from '../../shared/status.js';
import { https, instant, text } from '../../shared/entity-schemas.js';
import { generatedPath, PUBLIC_MARKER, readPublicMarker, serialize } from './directory.js';
import type { ReleaseOptions, ReleaseReport } from './types.js';

export async function validateRelease(directory: string, options: ReleaseOptions = {}): Promise<ReleaseReport> {
  const report: ReleaseReport = { valid: false, errors: [], files: [], summaryGzipBytes: 0, snapshotId: null };
  const fail = (message: string) => report.errors.push(message);
  try {
    const target = await safeDirectory(directory);
    const marker = await readPublicMarker(target);
    if (new Set(marker.files).size !== marker.files.length
      || new Set(marker.snapshots.map(({ snapshotId }) => snapshotId)).size !== marker.snapshots.length) throw new Error('Duplicate release inventory');
    const disk = await inventory(target);
    for (const path of disk) {
      if (generatedPath.safeParse(path).success && !marker.files.includes(path)) fail(`Undeclared generated artifact: ${path}`);
    }
    const values = new Map<string, unknown>();
    for (const path of marker.files) {
      try {
        const stat = await lstat(join(target, path));
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Expected regular artifact file');
        const body = await readFile(join(target, path), 'utf8');
        let parsed: unknown;
        if (path.endsWith('.json')) {
          const raw: unknown = JSON.parse(body);
          let schema: z.ZodType;
          if (/\/manifest\.json$/.test(path)) schema = manifestSchema;
          else if (/\/summary\.json$/.test(path)) schema = summarySchema;
          else if (/\/providers\/[^/]+\.json$/.test(path)) schema = providerDetailSchema;
          else if (/\/incidents\/recent\.json$/.test(path)) schema = recentSchema;
          else if (/\/meta\/health\.json$/.test(path)) schema = healthSchema;
          else if (/\/search\.json$/.test(path)) schema = searchSchema;
          else if (/\/archive\/(?:index\.json|indexes\/[^/]+\.json)$/.test(path)) schema = archiveIndexSchema;
          else if (/\/archive\/\d{4}-\d{2}(?:\/[a-f0-9]{24})?\.json$/.test(path)) schema = archiveSchema;
          else throw new Error('Unknown public JSON path');
          parsed = schema.parse(raw);
          const mode = z.object({ dataMode: z.enum(['live', 'fixture']) }).parse(parsed).dataMode;
          if (options.requireLive && mode !== 'live') fail(`Fixture artifact rejected: ${path}`);
        } else {
          if (XMLValidator.validate(body) !== true || /<!DOCTYPE|<!ENTITY/i.test(body)) throw new Error('Invalid feed XML');
          parsed = new XMLParser({ ignoreAttributes: false }).parse(body);
          const xml = z.record(z.string(), z.unknown()).parse(parsed);
          const root = z.record(z.string(), z.unknown()).parse(xml.rss ?? xml.feed);
          if (root['@_sg:schemaVersion'] !== '1.0' || !['live', 'fixture'].includes(String(root['@_sg:dataMode']))
            || typeof root['@_sg:snapshotId'] !== 'string') throw new Error('Invalid feed envelope');
          if (options.requireLive && root['@_sg:dataMode'] !== 'live') fail(`Fixture feed rejected: ${path}`);
        }
        values.set(path, parsed);
        report.files.push({ path, parsed, bytes: Buffer.byteLength(body), gzipBytes: gzipSync(body).byteLength });
      } catch (error) { fail(`${path}: ${error instanceof Error ? error.message : 'Invalid artifact'}`); }
    }
    const get = (path: string) => {
      if (!generatedPath.safeParse(path).success || !marker.files.includes(path) || !values.has(path)) {
        throw new Error(`Missing or unsafe referenced artifact: ${path}`);
      }
      return values.get(path);
    };
    const equal = (a: unknown, b: unknown, label: string) => {
      if (serialize(a) !== serialize(b)) throw new Error(`Cross-file mismatch: ${label}`);
    };
    const current = manifestSchema.parse(get('api/v1/manifest.json'));
    report.snapshotId = current.snapshotId;
    const expectedIds = options.providerIds ?? registry.filter(({ enabled }) => enabled).map(({ id }) => id);
    const checkManifest = (manifest: Manifest) => {
      const base = `/api/v1/snapshots/${manifest.snapshotId}`;
      equal(Object.keys(manifest.paths.providers).sort(), [...expectedIds].sort(), 'configured provider details');
      equal(manifest.paths.summary, `${base}/summary.json`, 'summary path');
      equal(manifest.paths.search, `${base}/search.json`, 'search path');
      equal(manifest.paths.recentIncidents, `${base}/incidents/recent.json`, 'recent path');
      equal(manifest.paths.health, `${base}/meta/health.json`, 'health path');
      equal(manifest.paths.archiveIndex, `/api/v1/incidents/archive/indexes/${manifest.archiveIndexRevision}.json`, 'index path');
      for (const [id, path] of Object.entries(manifest.paths.providers)) equal(path, `${base}/providers/${id}.json`, 'provider path');
      const envelope = (value: unknown) => z.object({
        schemaVersion: z.literal('1.0'), snapshotId: z.string(), generatedAt: z.string(),
        intervalMinutes: z.number(), dataMode: z.enum(['live', 'fixture']),
      }).parse(value);
      const manifestEnvelope = envelope(manifest);
      const paths = [manifest.paths.summary, manifest.paths.search, manifest.paths.recentIncidents,
        manifest.paths.health, ...Object.values(manifest.paths.providers)];
      for (const path of paths) equal(envelope(get(path.slice(1))), manifestEnvelope, `snapshot envelope ${path}`);
      const summary = summarySchema.parse(get(manifest.paths.summary.slice(1)));
      equal(summary.providers.map(({ id }) => id).sort(), [...expectedIds].sort(), 'summary providers');
      const search = searchSchema.parse(get(manifest.paths.search.slice(1)));
      equal(search.providers.map(({ providerId }) => providerId).sort(), [...expectedIds].sort(), 'search providers');
      const health = healthSchema.parse(get(manifest.paths.health.slice(1)));
      equal(health.providers.map(({ providerId }) => providerId).sort(), [...expectedIds].sort(), 'health providers');
      equal(health.runId, manifest.snapshotId, 'health run');
      equal(health.latestPublishedSnapshotId, manifest.snapshotId, 'health published version');
      for (const provider of summary.providers) {
        const detail = providerDetailSchema.parse(get(manifest.paths.providers[provider.id]!.slice(1)));
        equal(detail.provider, provider, 'provider summary/detail');
        const components = detail.componentGroups.flatMap(({ components }) => components);
        equal(components.length, provider.componentSummary.total, 'component count');
        equal(detail.dailyHistory30d.map(({ observedCoverageMinutes, unknownMinutes }) => ({ observedCoverageMinutes, unknownMinutes })),
          provider.dailyCoverage30d, 'daily coverage summary/detail');
        const today = Math.floor(Date.parse(manifest.generatedAt) / 86_400_000) * 86_400_000;
        equal(detail.dailyHistory30d.map(({ date }) => date), Array.from({ length: 30 }, (_, index) =>
          new Date(today - (29 - index) * 86_400_000).toISOString().slice(0, 10)), 'UTC daily history dates');
        equal(detail.dailyHistory30d.map((day) => day.worstStatus && STATUS_SEVERITY[day.worstStatus] > 0
          ? String(STATUS_SEVERITY[day.worstStatus]) : day.worstStatus === 'operational' && day.unknownMinutes === 0 ? '0' : '9').join(''),
        provider.dailyTrack30d, 'daily track summary/detail');
        if (new Set(components.map(({ id }) => id)).size !== components.length
          || detail.recentIncidents.some(({ providerId }) => providerId !== provider.id)) throw new Error('Invalid provider scope');
        if (new Set(provider.activeIncidents.map(({ id }) => id)).size !== provider.activeIncidents.length) throw new Error('Duplicate active incidents');
        for (const active of provider.activeIncidents) {
          const incident = detail.recentIncidents.find(({ id }) => id === active.id);
          if (!incident || incident.kind !== 'incident' || !incident.severity || incident.severity === 'maintenance'
            || ['resolved', 'completed', 'scheduled'].includes(incident.state) || incident.supersededBy) {
            throw new Error('Invalid active fault summary');
          }
          const { id, title, severity, origin, startedAt, updatedAt, sourceUrl } = incident;
          equal(active, { id, title, severity, origin, startedAt, updatedAt, sourceUrl }, 'active fault detail');
        }
        const index = search.providers.find(({ providerId }) => providerId === provider.id)!;
        if (components.some((component) => ![component.name, ...component.aliases].every((name) => index.components.includes(name)))) {
          throw new Error('Search omitted discovered components');
        }
        equal(health.providers.find(({ providerId }) => providerId === provider.id)?.collection, provider.collection, 'health collection');
      }
      const index = archiveIndexSchema.parse(get(manifest.paths.archiveIndex.slice(1)));
      equal(index.revision, manifest.archiveIndexRevision, 'archive index revision');
      equal(index.dataMode, manifest.dataMode, 'archive index mode');
      return summary;
    };
    const summary = checkManifest(current);
    const summaryFile = report.files.find(({ path }) => path === current.paths.summary.slice(1));
    report.summaryGzipBytes = summaryFile?.gzipBytes ?? 0;
    const max = options.maxSummaryGzipBytes ?? 40 * 1024;
    if (report.summaryGzipBytes > max) fail(`Summary Gzip size ${report.summaryGzipBytes} exceeds budget ${max}`);
    for (const snapshot of marker.snapshots) {
      const manifest = manifestSchema.parse(get(snapshot.manifestPath));
      equal(snapshot.snapshotId, manifest.snapshotId, 'retained snapshot ID');
      equal(snapshot.generatedAt, manifest.generatedAt, 'retained snapshot time');
      equal(snapshot.manifestPath, `api/v1/snapshots/${manifest.snapshotId}/manifest.json`, 'retained manifest path');
      checkManifest(manifest);
    }
    if (!marker.snapshots.some(({ snapshotId }) => snapshotId === current.snapshotId)) throw new Error('Missing current retained manifest');
    for (const [path, value] of values) {
      if (/\/archive\/(?:index\.json|indexes\/[^/]+\.json)$/.test(path)) {
        const index = archiveIndexSchema.parse(value);
        equal(index.revision, revisionOf({ dataMode: index.dataMode, months: index.months }), 'index content revision');
        equal(index.generatedAt, index.months.map(({ updatedAt }) => updatedAt).sort().at(-1)
          ?? '1970-01-01T00:00:00.000Z', 'index deterministic timestamp');
        if (new Set(index.months.map(({ month }) => month)).size !== index.months.length) throw new Error('Duplicate archive month');
        if (path.includes('/indexes/')) equal(path, `api/v1/incidents/archive/indexes/${index.revision}.json`, 'immutable index path');
        for (const month of index.months) {
          equal(month.path, `/api/v1/incidents/archive/${month.month}/${month.revision}.json`, 'immutable month path');
          const archive = archiveSchema.parse(get(month.path.slice(1)));
          equal(archive.revision, month.revision, 'archive revision');
          equal(archive.month, month.month, 'archive month');
          equal(archive.dataMode, index.dataMode, 'archive mode');
          equal(archive.incidents.length, month.incidentCount, 'archive count');
          equal(archive.incidents.map(({ startedAt }) => startedAt).sort()[0] ?? null, month.minStartedAt, 'archive minimum');
          equal(archive.incidents.flatMap(({ resolvedAt }) => resolvedAt ? [resolvedAt] : []).sort().at(-1) ?? null, month.maxResolvedAt, 'archive maximum');
          equal(archive.updatedAt, month.updatedAt, 'archive update');
        }
      } else if (/\/archive\/\d{4}-\d{2}(?:\/[a-f0-9]{24})?\.json$/.test(path)) {
        const archive = archiveSchema.parse(value);
        equal(archive.revision, revisionOf({ dataMode: archive.dataMode, incidents: archive.incidents }), 'month content revision');
        equal(archive.updatedAt, archive.incidents.map(({ updatedAt, lastObservedAt }) =>
          updatedAt > lastObservedAt ? updatedAt : lastObservedAt).sort().at(-1), 'archive deterministic timestamp');
        if (archive.incidents.some(({ startedAt }) => startedAt.slice(0, 7) !== archive.month)) throw new Error('Archive incident in wrong month');
        const expected = `api/v1/incidents/archive/${archive.month}`;
        equal(path, path.endsWith(`/${archive.revision}.json`) ? `${expected}/${archive.revision}.json` : `${expected}.json`, 'month path');
      } else if (path.startsWith('feed/')) {
        const xml = z.record(z.string(), z.unknown()).parse(value);
        const root = z.record(z.string(), z.unknown()).parse(xml.rss ?? xml.feed);
        equal(root['@_sg:snapshotId'], current.snapshotId, 'feed snapshot');
        equal(root['@_sg:dataMode'], current.dataMode, 'feed mode');
        const atom = path === 'feed/atom.xml';
        const content = atom ? root : z.record(z.string(), z.unknown()).parse(root.channel);
        if (atom ? !content.id || !content.title || !content.updated : !content.title || !content.link || !content.description) throw new Error('Invalid feed channel');
        const raw = atom ? content.entry : content.item;
        const entries = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
        const ids: string[] = [];
        for (const entry of entries) {
          const fields = atom ? z.strictObject({
            id: text, title: text, updated: instant, link: z.strictObject({ '@_href': https }),
            content: z.strictObject({ '@_type': z.literal('text'), '#text': z.string().optional() }),
          }).parse(entry) : z.strictObject({
            guid: z.strictObject({ '#text': text, '@_isPermaLink': z.literal('false') }),
            title: text, link: https, pubDate: text.refine((value) => Number.isFinite(Date.parse(value))),
            description: z.string(),
          }).parse(entry);
          const identity = 'id' in fields ? fields.id : fields.guid['#text'];
          if (!/:(?:triggered|resolved|escalated:.+)$/.test(identity)) throw new Error('Invalid milestone feed entry');
          ids.push(identity);
        }
        if (new Set(ids).size !== ids.length) throw new Error('Duplicate feed milestone IDs');
      }
    }
    for (const entry of marker.monthVersions) {
      const archive = archiveSchema.parse(get(entry.path));
      equal(entry.month, archive.month, 'retained month metadata');
      equal(entry.revision, archive.revision, 'retained revision metadata');
      equal(entry.path, `api/v1/incidents/archive/${entry.month}/${entry.revision}.json`, 'retained month path');
    }
    const aliases = { 'summary.json': summary, 'search.json': get(current.paths.search.slice(1)),
      'incidents/recent.json': get(current.paths.recentIncidents.slice(1)), 'meta/health.json': get(current.paths.health.slice(1)),
      'incidents/archive/index.json': get(current.paths.archiveIndex.slice(1)),
      ...Object.fromEntries(expectedIds.map((id) => [`providers/${id}.json`, get(current.paths.providers[id]!.slice(1))])) };
    for (const [path, value] of Object.entries(aliases)) equal(get(`api/v1/${path}`), value, `latest alias ${path}`);
    const latestIndex = archiveIndexSchema.parse(get(current.paths.archiveIndex.slice(1)));
    for (const month of latestIndex.months) equal(get(`api/v1/incidents/archive/${month.month}.json`), get(month.path.slice(1)), 'month alias');
    for (const path of ['feed/all.xml', 'feed/atom.xml', ...['ai', 'cloud-cn', 'cloud-global', 'infra'].map((category) =>
      `feed/category/${category}.xml`), ...expectedIds.map((id) => `feed/provider/${id}.xml`)]) get(path);
    if (!disk.includes(PUBLIC_MARKER)) throw new Error('Missing release marker');
  } catch (error) { fail(error instanceof Error ? error.message : 'Invalid release'); }
  report.valid = report.errors.length === 0;
  return report;
}
