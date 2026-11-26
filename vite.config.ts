import { defineConfig } from 'vite';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

// Explicit local data selection never changes production's public API paths.
const selectedData = process.env.STATUSGRID_DATA_DIR;
export default defineConfig({
  plugins: selectedData ? [{
    name: 'statusgrid-selected-local-data',
    configureServer(server) {
      const root = resolve(selectedData);
      server.middlewares.use(async (request, response, next) => {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname;
        if (!path.startsWith('/api/') && !path.startsWith('/feed/')) return next();
        const file = resolve(root, `.${decodeURIComponent(path)}`);
        if (!file.startsWith(`${root}${sep}`)) { response.statusCode = 400; response.end(); return; }
        try {
          const body = await readFile(file);
          response.setHeader('Content-Type', path.endsWith('.json') ? 'application/json' : 'application/xml');
          response.end(body);
        } catch { response.statusCode = 404; response.end('No published artifact'); }
      });
    },
  }] : [],
});
