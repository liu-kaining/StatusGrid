import type { ReleaseOptions } from '../src/collector/export/types.js';
import { appendFile, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import registry from '../registry/providers.json';
import { parseRegistry } from '../src/shared/schemas.js';
import { runPersistentCollection } from '../src/collector/run.js';
import { createHttpClient } from '../src/collector/http.js';
import { createBrowserPool } from '../src/collector/browser.js';
import { loadState } from '../src/collector/storage/load.js';
import { readBranch } from './update-snapshot.js';
import { prepareRelease, readReceipt, validatePreparedRelease } from './prepare-release.js';
import { frontendFingerprint, readInterval, shouldSkipSync } from './release-policy.js';
import { publishRelease } from './publish-release.js';
import { backupState } from './backup-state.js';
import { git } from './git.js';
export interface WorkflowOptions extends ReleaseOptions {
  repository: string; workDir: string; mode: 'frontend' | 'sync' | 'retry' | 'backup';
  sourceSha: string; shellDir?: string; expectedFingerprint?: string; intervalMinutes?: 5 | 10;
  manual?: boolean; now?: string;
  collect?: (stateDir: string, interval: 5 | 10) => ReturnType<typeof runPersistentCollection>;
}
export interface WorkflowResult {
  status: 'published' | 'skipped' | 'backed-up'; reason?: string; siteDir?: string; backupPath?: string;
}
async function collectStaged(stateDir: string, intervalMinutes: 5 | 10) {
  const browser = createBrowserPool({
    timeoutMs: 60_000,
    ...(process.env.STATUSGRID_BROWSER_EXECUTABLE ? { executablePath: process.env.STATUSGRID_BROWSER_EXECUTABLE } : {}),
  });
  const controller = new AbortController();
  try {
    return await runPersistentCollection(parseRegistry(registry).filter(({ enabled }) => enabled), {
      now: new Date().toISOString(), signal: controller.signal, intervalMinutes, browser,
      http: createHttpClient({ timeoutMs: 8_000, retries: 0 }),
      httpForProvider: (config) => createHttpClient({
        timeoutMs: config.adapter.timeoutMs, retries: config.adapter.retries,
        totalBudgetMs: Math.min(50_000, config.adapter.timeoutMs * (config.adapter.retries + 1) + 4_000),
      }),
    }, stateDir);
  } finally { controller.abort(); await browser.close(); }
}
async function currentFingerprint(repository: string) {
  await git(repository, ['fetch', '--no-tags', 'origin', 'refs/heads/main']);
  return frontendFingerprint(repository, 'FETCH_HEAD');
}
export async function runWorkflowRelease(options: WorkflowOptions): Promise<WorkflowResult> {
  const { repository, workDir, mode } = options;
  await mkdir(workDir, { recursive: false });
  const obsolete = async () => mode === 'frontend' && options.expectedFingerprint !== undefined
    && options.expectedFingerprint !== await currentFingerprint(repository);
  if (await obsolete()) return { status: 'skipped', reason: 'Frontend inputs have been superseded on main' };
  const data = await readBranch(repository, 'data', join(workDir, 'data'));
  const previous = await loadState(data.directory);
  if (mode === 'backup') {
    if (!previous.latest) return { status: 'skipped', reason: 'No collected state to back up' };
    const backupPath = join(workDir, `statusgrid-state-${(options.now ?? new Date().toISOString()).slice(0, 10)}.tar.gz`);
    await backupState(data.directory, backupPath);
    return { status: 'backed-up', backupPath };
  }
  const pages = await readBranch(repository, 'gh-pages', join(workDir, 'pages'));
  if (mode !== 'frontend' && !pages.sha) throw new Error('No durable frontend shell: run frontend workflow first');
  if (pages.sha) {
    const validation = await validatePreparedRelease(pages.directory, options);
    if (!validation.valid) throw new Error(`Invalid durable shell: ${validation.errors.join('; ')}`);
  }
  if (mode === 'sync' && shouldSkipSync(options.now ?? new Date().toISOString(), previous.latest?.completedAt ?? null,
    options.intervalMinutes ?? 5, options.manual ?? false)) {
    return { status: 'skipped', reason: 'Already updated within half the collection interval' };
  }
  if (mode === 'sync') {
    const collected = await (options.collect ?? collectStaged)(data.directory, options.intervalMinutes ?? 5);
    if (collected.kind !== 'valid') throw new Error('Collection did not produce validated persistent state');
    // Business failures are a valid stale/missing signal; all infrastructure exceptions propagate.
  }
  const receipt = pages.sha ? await readReceipt(pages.directory) : null;
  const siteDir = join(workDir, 'site');
  const shellDir = mode === 'frontend' ? options.shellDir : pages.directory;
  if (!shellDir) throw new Error('Frontend mode requires a built shell directory');
  await prepareRelease(shellDir, data.directory, siteDir, {
    ...options, sourceSha: mode === 'frontend' ? options.sourceSha : receipt?.sourceSha,
    frontendFingerprint: mode === 'frontend' ? options.expectedFingerprint : receipt?.frontendFingerprint,
    ...(mode === 'frontend' && pages.sha ? { previousReleaseDir: pages.directory } : {}),
  });
  // Main can advance during staging. Only frontend content changes make this shell obsolete.
  if (await obsolete()) return { status: 'skipped', reason: 'Frontend inputs changed during release staging' };
  await publishRelease({ ...options, stateDir: data.directory, siteDir, data, pages });
  return { status: 'published', siteDir };
}

async function output(values: Record<string, string>) {
  const body = Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n');
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${body}\n`);
  console.log(body);
}
export async function main(argv: string[]): Promise<void> {
  const repository = process.cwd();
  if (argv[0] === 'check') {
    const tracked = (await git(repository, ['ls-files'])).split('\n');
    if (tracked.some((path) => /^(?:\.statusgrid|dist|public\/api|public\/feed)\//.test(path)
      || /(?:^|\/)(?:collection-run\.json|\.env(?:\..*)?|[^/]+\.har)$/.test(path))) {
      throw new Error('Generated data or private captures are tracked in source');
    }
    await mkdir('.statusgrid', { recursive: true });
    const temporary = await mkdtemp(resolve('.statusgrid/check-'));
    const report = await prepareRelease(resolve('dist'), join(temporary, 'absent'), join(temporary, 'site'));
    console.log(`Production shell validated: ${report.valid}; snapshot: ${report.snapshotId ?? 'empty'}`);
    return;
  }
  if (argv[0] === 'gate') {
    const fingerprint = await frontendFingerprint(repository, 'HEAD');
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH!, 'utf8')) as { before?: string };
    const previous = event.before && !/^0+$/.test(event.before) ? await frontendFingerprint(repository, event.before) : null;
    await output({ fingerprint, changed: String(process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' || fingerprint !== previous) });
    return;
  }
  if (argv[0] !== 'run') throw new Error('Expected workflow-release gate, check or run');
  const mode = process.env.RELEASE_MODE ?? 'sync';
  if (!['frontend', 'sync', 'retry', 'backup'].includes(mode)) throw new Error('Unknown release mode');
  const base = resolve(process.env.RUNNER_TEMP ?? '.statusgrid');
  await mkdir(base, { recursive: true });
  const workDir = join(await mkdtemp(join(base, 'statusgrid-release-')), 'staging');
  const result = await runWorkflowRelease({
    repository, workDir, mode: mode as WorkflowOptions['mode'],
    sourceSha: process.env.SOURCE_SHA ?? await git(repository, ['rev-parse', 'HEAD']),
    ...(process.env.SHELL_DIR ? { shellDir: resolve(process.env.SHELL_DIR) } : {}),
    ...(process.env.FRONTEND_FINGERPRINT ? { expectedFingerprint: process.env.FRONTEND_FINGERPRINT } : {}),
    intervalMinutes: process.env.INTERVAL_MINUTES
      ? readIntervalFromEnvironment(process.env.INTERVAL_MINUTES) : await readInterval(process.env.GITHUB_EVENT_PATH),
    manual: process.env.GITHUB_EVENT_NAME === 'workflow_dispatch',
  });
  await output({
    status: result.status, publish: String(result.status === 'published'),
    site: result.siteDir ?? '', backup: result.backupPath ?? '',
  });
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `StatusGrid: ${result.status}${result.reason ? ` — ${result.reason}` : ''}.\n`);
}
function readIntervalFromEnvironment(value: string): 5 | 10 {
  if (!['5', '10'].includes(value)) throw new Error('Interval must be 5 or 10 minutes');
  return Number(value) as 5 | 10;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Release workflow failed');
    process.exitCode = 2;
  });
}
