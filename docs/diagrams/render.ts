import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Run from the repository root: npx tsx docs/diagrams/render.ts
const directory = dirname(fileURLToPath(import.meta.url));
const names = ['architecture', 'collection-release', 'data-flow'];
const configured = process.env.STATUSGRID_BROWSER_EXECUTABLE;
const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = configured ?? (!existsSync(chromium.executablePath()) && existsSync(macChrome) ? macChrome : undefined);
const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}) });
try {
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  for (const name of names) {
    const source = await readFile(join(directory, `${name}.svg`), 'utf8');
    await page.setContent(`<html><head><meta charset="utf-8"></head><body style="margin:0">${source}</body></html>`);
    await page.evaluate(() => document.fonts.ready);
    const result = await page.evaluate(() => {
      const svg = document.querySelector('svg')!;
      const bounds = svg.viewBox.baseVal;
      const errors = [...svg.querySelectorAll('text')].flatMap((element) => {
        const box = element.getBBox();
        return box.x < 0 || box.y < 0 || box.x + box.width > bounds.width || box.y + box.height > bounds.height
          ? [`Text outside canvas: ${element.textContent}`] : [];
      });
      return { width: bounds.width, height: bounds.height, errors };
    });
    if (result.errors.length) throw new Error(`${name}: ${result.errors.join('; ')}`);
    await page.setViewportSize({ width: result.width, height: result.height });
    const output = join(directory, `${name}.png`);
    await page.locator('svg').screenshot({ path: output });
    console.log(`${name}.png: ${result.width * 2} × ${result.height * 2}`);
  }
} finally {
  await browser.close();
}
