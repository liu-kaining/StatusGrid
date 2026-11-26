import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { instant, text } from '../../shared/entity-schemas.js';
import { publicPathSchema, revisionSchema } from '../../shared/public-schemas.js';

export const PUBLIC_MARKER = '.statusgrid-public.json';
export const generatedPath = z.string().refine((value) =>
  publicPathSchema.safeParse(`/${value}`).success && !value.startsWith('/')
  && (value.startsWith('api/v1/') && value.endsWith('.json') || value.startsWith('feed/') && value.endsWith('.xml')), 'Unsafe generated artifact path');
export const publicMarkerSchema = z.strictObject({
  kind: z.literal('statusgrid-public'), schemaVersion: z.literal('1.0'), files: z.array(generatedPath),
  snapshots: z.array(z.strictObject({ snapshotId: text, generatedAt: instant, manifestPath: generatedPath })),
  monthVersions: z.array(z.strictObject({
    month: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/), revision: revisionSchema, path: generatedPath, publishedAt: instant,
  })),
});
export type PublicMarker = z.infer<typeof publicMarkerSchema>;
export const readPublicMarker = async (directory: string) =>
  publicMarkerSchema.parse(JSON.parse(await readFile(join(directory, PUBLIC_MARKER), 'utf8')));
export const serialize = (value: unknown) => `${JSON.stringify(value)}\n`;
export const immutablePath = (path: string) => path.startsWith('api/v1/snapshots/')
  || /^api\/v1\/incidents\/archive\/(?:indexes|\d{4}-\d{2})\/[a-f0-9]{24}\.json$/.test(path);
