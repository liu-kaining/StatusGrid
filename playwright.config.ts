import { defineConfig } from '@playwright/test';
import { browserExecutable } from './tests/helpers/browser-executable.js';

// Playwright forces color in its workers/web server. Avoid passing a conflicting
// inherited NO_COLOR to those Node processes (which otherwise warn on startup).
delete process.env.NO_COLOR;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  workers: 2,
  use: { baseURL: 'http://127.0.0.1:5173', colorScheme: 'dark', viewport: { width: 1440, height: 1050 },
    launchOptions: { executablePath: browserExecutable() }, trace: 'retain-on-failure' },
  webServer: { command: process.env.STATUSGRID_E2E_SERVER ?? 'npm run preview:fixture',
    url: 'http://127.0.0.1:5173', reuseExistingServer: false, timeout: 30_000 },
});
