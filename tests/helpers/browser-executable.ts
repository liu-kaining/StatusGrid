import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

export function browserExecutable(): string | undefined {
  if (process.env.STATUSGRID_BROWSER_EXECUTABLE) return process.env.STATUSGRID_BROWSER_EXECUTABLE;
  if (existsSync(chromium.executablePath())) return undefined;
  const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  return process.platform === 'darwin' && existsSync(macChrome) ? macChrome : undefined;
}
