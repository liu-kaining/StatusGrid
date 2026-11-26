import { resolve } from 'node:path';
import { writePublicArtifacts } from '../src/collector/export/manifest.js';
import { webFixture } from '../tests/helpers/web-fixture.js';

const root = resolve('.statusgrid/fixture/public');
await writePublicArtifacts(webFixture(new Date().toISOString()), root);
console.log(`Explicit fixture preview exported to ${root}`);
