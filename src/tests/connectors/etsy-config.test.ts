import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { loadEtsyConnectorConfig } from '../../core/config.js';

describe('Etsy connector configuration boundary', () => {
  it('loads sanitized Etsy connector config from the supplied env object only', () => {
    process.env.ETSY_API_KEY = 'wrong-process-value';

    const config = loadEtsyConnectorConfig({
      ETSY_API_KEY: 'test-api-key',
      ETSY_API_SECRET: 'do-not-return-this-secret',
      ETSY_OAUTH_CLIENT_ID: 'test-client-id',
      ETSY_OAUTH_REDIRECT_URI: 'http://localhost:3000/oauth/etsy/callback',
      ETSY_OAUTH_SCOPES: 'shops_r listings_r transactions_r',
      ETSY_TOKEN_STORAGE_PATH: '.local/etsy-token.json',
    });

    expect(config).toEqual({
      apiKey: 'test-api-key',
      oauthClientId: 'test-client-id',
      oauthRedirectUri: 'http://localhost:3000/oauth/etsy/callback',
      scopes: ['shops_r', 'listings_r', 'transactions_r'],
      tokenStoragePath: '.local/etsy-token.json',
    });
    expect(JSON.stringify(config)).not.toContain('do-not-return-this-secret');
    expect(config.apiKey).not.toBe('wrong-process-value');

    delete process.env.ETSY_API_KEY;
  });

  it('throws configuration_failed when required values are missing', () => {
    expect(() => loadEtsyConnectorConfig({ ETSY_API_KEY: 'test-api-key' })).toThrow(
      expect.objectContaining({
        code: 'configuration_failed',
        message: 'Missing required Etsy connector configuration: ETSY_OAUTH_CLIENT_ID',
      }),
    );
  });

  it('keeps the workflow engine independent from connector config loading', async () => {
    const engineSource = await readFile(new URL('../../workflow/engine.ts', import.meta.url), 'utf8');

    expect(engineSource).not.toContain('loadEtsyConnectorConfig');
    expect(engineSource).not.toContain('../core/config');
  });
});
