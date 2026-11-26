import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import registryFile from '../../registry/providers.json';
import { DEFAULT_INTERVAL_MINUTES, COLLECTION_INTERVAL_MINUTES } from '../shared/contracts.js';
import { parseRegistry } from '../shared/schemas.js';
import { createHttpClient } from './http.js';
import { createBrowserPool } from './browser.js';
import { collectProviders, runPersistentCollection } from './run.js';
import type { CollectionContext } from './types.js';
import { buildPublicArtifacts } from './export/json.js';
import { writePublicArtifacts } from './export/manifest.js';

const registry = parseRegistry(registryFile);
const providerIds = new Set(registry.map(({ id }) => id));

export interface CollectArgs {
  providers: string[];
  report: string;
  intervalMinutes: 5 | 10;
  stateDir?: string;
  outputDir?: string;
}

export function parseCollectArgs(argv: string[]): CollectArgs {
  const options: CollectArgs = {
    providers: registry.filter(({ enabled }) => enabled).map(({ id }) => id),
    report: '.statusgrid/collection-run.json',
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
  };
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !value || !flag.startsWith('--') || seen.has(flag)) {
      throw new Error('Expected unique collection flags with nonempty values');
    }
    seen.add(flag);
    if (flag === '--providers') {
      options.providers = value.split(',').map((id) => id.trim());
      if (!options.providers.length || new Set(options.providers).size !== options.providers.length
        || options.providers.some((id) => !providerIds.has(id))) {
        throw new Error(`Unknown provider or duplicate provider in: ${value}`);
      }
    } else if (flag === '--report') {
      options.report = value;
    } else if (flag === '--state-dir') {
      options.stateDir = value;
    } else if (flag === '--output-dir') {
      options.outputDir = value;
    } else if (flag === '--interval') {
      const interval = Number(value);
      if (!COLLECTION_INTERVAL_MINUTES.some((allowed) => allowed === interval)) {
        throw new Error(`Invalid collection interval: ${value}`);
      }
      options.intervalMinutes = interval as 5 | 10;
    } else {
      throw new Error(`Unknown collection flag: ${flag}`);
    }
  }
  if (options.stateDir && seen.has('--providers')) {
    throw new Error('--providers diagnostics cannot be combined with --state-dir persistence (subset snapshots are unsafe)');
  }
  if (options.outputDir && (!options.stateDir || seen.has('--providers'))) {
    throw new Error('Public output requires persistent full-provider mode with --state-dir');
  }
  const overlaps = (a: string, b: string) => resolve(a) === resolve(b)
    || resolve(a).startsWith(`${resolve(b)}${sep}`) || resolve(b).startsWith(`${resolve(a)}${sep}`);
  if (options.outputDir && options.stateDir && overlaps(options.outputDir, options.stateDir)) {
    throw new Error('Public output and state directories must not overlap');
  }
  if (options.outputDir && (resolve(options.report) === resolve(options.outputDir)
    || resolve(options.report).startsWith(`${resolve(options.outputDir)}${sep}`))) {
    throw new Error('Report path must not overlap public output');
  }
  if (options.stateDir && (resolve(options.report) === resolve(options.stateDir)
    || resolve(options.report).startsWith(`${resolve(options.stateDir)}${sep}`))) {
    throw new Error('Report path must not overlap the generated state directory');
  }
  return options;
}

export async function main(argv: string[], suppliedContext?: CollectionContext): Promise<void> {
  const options = parseCollectArgs(argv);
  const configs = options.providers.map((id) => {
    const provider = registry.find((entry) => entry.id === id);
    if (!provider) throw new Error(`Unknown registry provider: ${id}`);
    return provider;
  });
  const browser = suppliedContext?.browser ?? createBrowserPool({
    timeoutMs: 60_000,
    ...(process.env.STATUSGRID_BROWSER_EXECUTABLE ? { executablePath: process.env.STATUSGRID_BROWSER_EXECUTABLE } : {}),
  });
  const controller = new AbortController();
  try {
    const context: CollectionContext = suppliedContext ? { ...suppliedContext, intervalMinutes: options.intervalMinutes } : {
      now: new Date().toISOString(),
      signal: controller.signal,
      intervalMinutes: options.intervalMinutes,
      http: createHttpClient({ timeoutMs: 8_000, retries: 0 }),
      httpForProvider: (config) => createHttpClient({
        timeoutMs: config.adapter.timeoutMs, retries: config.adapter.retries,
        totalBudgetMs: Math.min(50_000, config.adapter.timeoutMs * (config.adapter.retries + 1) + 4_000),
      }),
      browser,
    };
    const persistent = options.stateDir ? await runPersistentCollection(configs, context, resolve(options.stateDir)) : null;
    const run = persistent?.run ?? await collectProviders(configs, new Map(), context);
    if (options.outputDir && persistent) {
      await writePublicArtifacts(buildPublicArtifacts(run, persistent.state), resolve(options.outputDir));
    }
    const report = resolve(options.report);
    await mkdir(dirname(report), { recursive: true });
    await writeFile(report, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
    for (const provider of run.providers) {
      console.log(`${provider.providerId}: ${provider.result?.reportedStatus ?? 'unavailable'} (${provider.collection.freshness}${provider.collection.reason ? `: ${provider.collection.reason}` : ''})`);
    }
    console.log(`Report: ${report} | interval: ${run.intervalMinutes} minutes (one collection run)`);
    // Business source failures are valid persisted stale snapshots; infrastructure failures throw.
    process.exitCode = !options.stateDir && run.providers.some(({ collection }) => collection.freshness !== 'fresh') ? 1 : 0;
  } finally {
    controller.abort();
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Collection failed');
    process.exitCode = 2;
  });
}
