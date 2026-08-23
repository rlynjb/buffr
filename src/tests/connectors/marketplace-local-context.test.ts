import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadMarketplaceVisibilityContext } from '../../connectors/marketplace/local-context.js';

describe('marketplace visibility local context loader', () => {
  it('loads a strict local context JSON file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'visibility-context-'));
    const file = join(dir, 'merchgrid.json');
    await writeFile(file, JSON.stringify({
      marketplace: 'shopify_app_store',
      productName: 'MerchGrid',
      currentSurfaceSummary: 'Shopify app listing for catalog audits',
      targetAudience: 'Shopify merchants',
      knownDiscoverySurface: 'Shopify App Store',
    }), 'utf8');

    await expect(loadMarketplaceVisibilityContext(file)).resolves.toMatchObject({
      marketplace: 'shopify_app_store',
      productName: 'MerchGrid',
    });
  });

  it('rejects non-local references and unsafe keys', async () => {
    await expect(loadMarketplaceVisibilityContext('https://example.com/context.json')).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });
});
