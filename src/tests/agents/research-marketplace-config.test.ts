import { describe, expect, it } from 'vitest';
import { loadMarketplaceResearchConfig } from '../../agents/research/marketplace-config.js';

describe('marketplace research configuration', () => {
  it('defaults marketplace research to disabled with official domains and hard caps', () => {
    expect(loadMarketplaceResearchConfig({})).toMatchObject({
      enabled: false,
      searchContextSize: 'medium',
      allowedDomains: expect.arrayContaining(['shopify.dev', 'help.shopify.com', 'etsy.com']),
      limits: { maxToolCalls: 3, maxWallClockMs: 120_000 },
    });
  });

  it('parses explicit safe configuration', () => {
    expect(
      loadMarketplaceResearchConfig({
        MARKETPLACE_RESEARCH_ENABLED: 'true',
        MARKETPLACE_RESEARCH_ALLOWED_DOMAINS: 'docs.example.test, help.example.test ',
        MARKETPLACE_RESEARCH_SEARCH_CONTEXT: 'low',
        MARKETPLACE_RESEARCH_MODEL: 'test-research-model',
        MARKETPLACE_RESEARCH_MAX_TOOL_CALLS: '2',
        MARKETPLACE_RESEARCH_MAX_WALL_CLOCK_MS: '90000',
        MARKETPLACE_RESEARCH_MAX_TOKENS: '1000',
        MARKETPLACE_RESEARCH_MAX_ESTIMATED_COST_USD: '0.25',
      }),
    ).toEqual({
      enabled: true,
      allowedDomains: ['docs.example.test', 'help.example.test'],
      searchContextSize: 'low',
      model: 'test-research-model',
      limits: {
        maxToolCalls: 2,
        maxWallClockMs: 90_000,
        maxTokens: 1000,
        maxEstimatedCostUsd: 0.25,
      },
    });
  });

  it.each([
    ['MARKETPLACE_RESEARCH_ENABLED', 'yes'],
    ['MARKETPLACE_RESEARCH_ALLOWED_DOMAINS', ''],
    ['MARKETPLACE_RESEARCH_SEARCH_CONTEXT', 'large'],
    ['MARKETPLACE_RESEARCH_MAX_TOOL_CALLS', '4'],
    ['MARKETPLACE_RESEARCH_MAX_WALL_CLOCK_MS', '120001'],
    ['MARKETPLACE_RESEARCH_MAX_TOKENS', '0'],
    ['MARKETPLACE_RESEARCH_MAX_ESTIMATED_COST_USD', '-1'],
  ])('rejects invalid %s', (key, value) => {
    expect(() =>
      loadMarketplaceResearchConfig({
        MARKETPLACE_RESEARCH_ENABLED: 'true',
        [key]: value,
      }),
    ).toThrow(expect.objectContaining({ code: 'configuration_failed' }));
  });
});
