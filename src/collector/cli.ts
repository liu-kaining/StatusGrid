import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_INTERVAL_MINUTES, COLLECTION_INTERVAL_MINUTES } from '../shared/contracts.js';
import { parseRegistry } from '../shared/schemas.js';
import { createHttpClient } from './http.js';
import { createBrowserPool } from './browser.js';
import { collectProviders } from './run.js';

export interface CollectArgs {
  providers: string[];
  report: string;
  intervalMinutes: 5 | 10;
}

export function parseCollectArgs(argv: string[]): CollectArgs {
  const options: CollectArgs = {
    providers: ['cloudflare', 'github', 'claude', 'openai', 'moonshot'],
    report: '.statusgrid/collection-run.json',
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
  };
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !value || !flag.startsWith('--') || seen.has(flag)) {
      throw new Error('Expected unique --providers, --report or --interval flags with values');
    }
    seen.add(flag);
    if (flag === '--providers') {
      options.providers = value.split(',').map((id) => id.trim());
      if (!options.providers.length || new Set(options.providers).size !== options.providers.length
        || options.providers.some((id) => !['cloudflare', 'github', 'claude', 'openai', 'moonshot'].includes(id))) {
        throw new Error(`Unknown provider or duplicate provider in: ${value}`);
      }
    } else if (flag === '--report') {
      options.report = value;
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
  return options;
}

export async function main(argv: string[]): Promise<void> {
  const options = parseCollectArgs(argv);
  const raw = JSON.parse(await readFile(resolve('registry/providers.json'), 'utf8')) as unknown;
  const registry = parseRegistry(raw);
  const configs = options.providers.map((id) => {
    const provider = registry.find((entry) => entry.id === id);
    if (!provider) throw new Error(`Unknown registry provider: ${id}`);
    return provider;
  });
  const browser = createBrowserPool({ timeoutMs: 60_000 });
  const controller = new AbortController();
  try {
    const run = await collectProviders(configs, new Map(), {
      now: new Date().toISOString(),
      signal: controller.signal,
      intervalMinutes: options.intervalMinutes,
      http: createHttpClient({ timeoutMs: 8_000, retries: 0 }),
      httpForProvider: (config) => createHttpClient({
        timeoutMs: config.adapter.timeoutMs, retries: config.adapter.retries,
        totalBudgetMs: Math.min(50_000, config.adapter.timeoutMs * (config.adapter.retries + 1) + 4_000),
      }),
      browser,
    });
    const report = resolve(options.report);
    await mkdir(dirname(report), { recursive: true });
    await writeFile(report, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
    for (const provider of run.providers) {
      console.log(`${provider.providerId}: ${provider.result?.reportedStatus ?? 'unavailable'} (${provider.collection.freshness}${provider.collection.reason ? `: ${provider.collection.reason}` : ''})`);
    }
    console.log(`Report: ${report} | interval: ${run.intervalMinutes} minutes (one collection run)`);
    if (run.providers.some(({ collection }) => collection.freshness !== 'fresh')) process.exitCode = 1;
  } finally {
    controller.abort();
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Collection failed');
    process.exitCode = 1;
  });
}
