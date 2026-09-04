import { z } from 'zod';
import { AppError } from '../../core/errors.js';
import { M3_DEFAULT_LIMITS } from '../core/policy.js';

export const DEFAULT_MARKETPLACE_RESEARCH_DOMAINS = [
  'shopify.dev',
  'help.shopify.com',
  'shopify.com',
  'apps.shopify.com',
  'etsy.com',
  'help.etsy.com',
  'developers.etsy.com',
] as const;

const DomainSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value) => value.toLowerCase())
  .refine((value) => /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(value), 'invalid public domain');

const MarketplaceResearchConfigSchema = z
  .object({
    enabled: z.boolean(),
    allowedDomains: z.array(DomainSchema).min(1),
    searchContextSize: z.enum(['low', 'medium', 'high']),
    model: z.string().trim().min(1).optional(),
    limits: z
      .object({
        maxToolCalls: z.number().int().min(1).max(M3_DEFAULT_LIMITS.maxToolCalls),
        maxWallClockMs: z.number().int().min(1).max(M3_DEFAULT_LIMITS.maxWallClockMs),
        maxTokens: z.number().int().positive().optional(),
        maxEstimatedCostUsd: z.number().positive().optional(),
      })
      .strict(),
  })
  .strict();

export type MarketplaceResearchConfig = z.infer<typeof MarketplaceResearchConfigSchema>;

export function loadMarketplaceResearchConfig(env: NodeJS.ProcessEnv): MarketplaceResearchConfig {
  try {
    return MarketplaceResearchConfigSchema.parse({
      enabled: parseBoolean(env.MARKETPLACE_RESEARCH_ENABLED, false),
      allowedDomains: parseDomains(env.MARKETPLACE_RESEARCH_ALLOWED_DOMAINS),
      searchContextSize: env.MARKETPLACE_RESEARCH_SEARCH_CONTEXT ?? 'medium',
      model: emptyToUndefined(env.MARKETPLACE_RESEARCH_MODEL),
      limits: {
        maxToolCalls: parseNumber(env.MARKETPLACE_RESEARCH_MAX_TOOL_CALLS, M3_DEFAULT_LIMITS.maxToolCalls),
        maxWallClockMs: parseNumber(
          env.MARKETPLACE_RESEARCH_MAX_WALL_CLOCK_MS,
          M3_DEFAULT_LIMITS.maxWallClockMs,
        ),
        maxTokens: parseOptionalNumber(env.MARKETPLACE_RESEARCH_MAX_TOKENS),
        maxEstimatedCostUsd: parseOptionalNumber(env.MARKETPLACE_RESEARCH_MAX_ESTIMATED_COST_USD),
      },
    });
  } catch (error) {
    throw new AppError('configuration_failed', 'Marketplace research configuration is invalid', { cause: error });
  }
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value as unknown as boolean;
}

function parseDomains(value: string | undefined): string[] {
  if (value === undefined) return [...DEFAULT_MARKETPLACE_RESEARCH_DOMAINS];
  return value.split(',').map((domain) => domain.trim());
}

function parseNumber(value: string | undefined, fallback: number): number {
  return value === undefined ? fallback : Number(value);
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  return value === undefined || value.trim() === '' ? undefined : Number(value);
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}
