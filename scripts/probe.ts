import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { createHttpClient } from '../src/collector/http.js';
import { parseRegistry } from '../src/shared/schemas.js';
import type { HttpClient } from '../src/shared/contracts.js';

type ProbeConfig = {
  id: string;
  adapter: { endpoints: Record<string, string>; timeoutMs: number; retries: number };
};

function publicUrl(value: string): string {
  const url = new URL(value);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.href;
}

export async function probeProvider(config: ProbeConfig, http: HttpClient, output: string): Promise<string> {
  const checkedAt = new Date().toISOString();
  const directory = join(output, checkedAt.replace(/[:.]/g, '-'), config.id);
  await mkdir(join(directory, 'responses'), { recursive: true });
  const responses: Record<string, object> = {};
  for (const [name, url] of Object.entries(config.adapter.endpoints)) {
    const response = await http.getResponse(url, new AbortController().signal);
    await writeFile(join(directory, 'responses', `${name}.body`), response.bytes);
    responses[name] = {
      sourceUrl: publicUrl(url),
      finalUrl: publicUrl(response.url),
      statusCode: response.status,
      contentType: response.contentType,
      encoding: response.encoding,
      durationMs: response.durationMs,
      bodyBytes: response.bytes.length,
      bodyHash: `sha256:${createHash('sha256').update(response.bytes).digest('hex')}`,
    };
  }
  await writeFile(join(directory, 'metadata.json'), JSON.stringify({
    providerId: config.id,
    checkedAt,
    environment: process.env.GITHUB_ACTIONS ? 'github-actions' : 'local',
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    responses,
  }, null, 2) + '\n');
  await writeFile(join(directory, 'result.json'), JSON.stringify({
    transport: 'success',
    parserVersion: null,
    semanticChecks: [],
  }, null, 2) + '\n');
  return directory;
}

async function main(args: string[]) {
  let providerId: string | undefined;
  let output = '.statusgrid/probes';
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--provider') providerId = args[++index];
    else if (args[index] === '--output') output = args[++index] ?? '';
    else throw new Error('Usage: npm run probe -- --provider <id> [--output .statusgrid/probes]');
  }
  if (!providerId || !output) throw new Error('Missing --provider or --output value');
  const registry = parseRegistry(JSON.parse(await readFile(new URL('../registry/providers.json', import.meta.url), 'utf8')) as unknown);
  const config = registry.find((entry) => entry.id === providerId && entry.enabled);
  if (!config) throw new Error(`Unknown or disabled provider: ${providerId}`);
  const http = createHttpClient({
    timeoutMs: config.adapter.timeoutMs,
    retries: config.adapter.retries,
    totalBudgetMs: 60000,
  });
  const directory = await probeProvider(config, http, resolve(output));
  console.log(`G0 transport evidence saved: ${directory}; semantics not validated`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Probe failed');
    process.exitCode = 1;
  });
}
