import { z } from 'zod';
import type { ProviderConfig } from './contracts';

const httpsUrl = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password;
}, 'Expected an HTTPS URL without credentials');

const nonempty = z.string().trim().min(1);
const componentGroupSchema = z.strictObject({
  id: nonempty,
  name: nonempty,
  upstreamIds: z.array(nonempty),
  namePatterns: z.array(nonempty),
});

export const providerConfigSchema: z.ZodType<ProviderConfig> = z.strictObject({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: nonempty,
  category: z.enum(['ai', 'cloud-cn', 'cloud-global', 'infra']),
  aliases: z.array(nonempty),
  tags: z.array(nonempty),
  officialStatusUrl: httpsUrl,
  officialHomeUrl: httpsUrl.nullable(),
  displayOrder: z.number().int().nonnegative(),
  enabled: z.boolean(),
  adapter: z.strictObject({
    type: z.enum([
      'statuspage-v2', 'incident-io', 'deepseek', 'flashduty', 'xai', 'opencode', 'instatus', 'google-cloud-json', 'apple-status',
      'azure-status', 'aws-cn-health', 'tencent-cloud', 'aliyun', 'baidu-cloud',
    ]),
    endpoints: z.record(nonempty, httpsUrl),
    sourcePageId: nonempty.optional(),
    timeoutMs: z.number().int().positive(),
    retries: z.number().int().nonnegative(),
    requiredRegions: z.array(nonempty),
    componentGroups: z.array(componentGroupSchema),
    componentDisplay: z.strictObject({
      excludeIds: z.array(nonempty),
      collapseOperational: z.boolean(),
    }).optional(),
    browserFallback: z.boolean(),
  }),
});

export const registrySchema = z.array(providerConfigSchema).superRefine((providers, context) => {
  const ids = new Set<string>();
  for (const [index, provider] of providers.entries()) {
    if (ids.has(provider.id)) {
      context.addIssue({
        code: 'custom', path: [index, 'id'], message: `Duplicate provider id: ${provider.id}`,
      });
    }
    ids.add(provider.id);

    if (['aliyun', 'tencent-cloud', 'baidu-cloud'].includes(provider.adapter.type)
      && !provider.adapter.requiredRegions.length) {
      context.addIssue({ code: 'custom', path: [index, 'adapter', 'requiredRegions'],
        message: 'Public regional source requires an explicit nonempty region scope' });
    }
    if (['incident-io', 'instatus'].includes(provider.adapter.type) && !provider.adapter.sourcePageId) {
      context.addIssue({ code: 'custom', path: [index, 'adapter', 'sourcePageId'],
        message: `${provider.adapter.type} requires a pinned official page identity` });
    }
    if (provider.adapter.type === 'flashduty' && !/^[1-9][0-9]*$/.test(provider.adapter.sourcePageId ?? '')) {
      context.addIssue({ code: 'custom', path: [index, 'adapter', 'sourcePageId'],
        message: 'Flashduty requires a pinned numeric official page identity' });
    }

    const regions = new Set<string>();
    for (const [regionIndex, region] of provider.adapter.requiredRegions.entries()) {
      const key = region.toLowerCase();
      if (regions.has(key)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'adapter', 'requiredRegions', regionIndex],
          message: `Duplicate required region: ${region}`,
        });
      }
      regions.add(key);
    }
  }
});

export function parseRegistry(input: unknown): ProviderConfig[] {
  return registrySchema.parse(input);
}
