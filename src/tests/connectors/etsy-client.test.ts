import { describe, expect, it } from 'vitest';
import { AppError } from '../../core/errors.js';
import { EtsyOpenApiClient } from '../../connectors/etsy/client.js';
import { createEtsyEvidenceRepository } from '../../connectors/etsy/repository.js';
import { validateEtsyConnection } from '../../connectors/etsy/validate.js';
import type { EtsyConnectorConfig } from '../../core/config.js';
import type { EtsyTokenProvider } from '../../connectors/etsy/auth.js';

describe('Etsy Open API read-only client', () => {
  it('sends read-only GET requests with OAuth bearer token and x-api-key headers', async () => {
    const requests: Request[] = [];
    const client = new EtsyOpenApiClient({
      config: config(),
      tokenProvider: tokenProvider(),
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init));
        return jsonResponse({ ok: true });
      },
    });

    await expect(client.getJson('/listings/123', { includes: 'Images', active: true })).resolves.toEqual({
      ok: true,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('GET');
    expect(requests[0].url).toBe(
      'https://openapi.etsy.com/v3/application/listings/123?includes=Images&active=true',
    );
    expect(requests[0].headers.get('authorization')).toBe('Bearer test-token');
    expect(requests[0].headers.get('x-api-key')).toBe('test-api-key');
  });

  it('does not expose write methods', () => {
    const client = new EtsyOpenApiClient({ config: config(), tokenProvider: tokenProvider(), fetchImpl: async () => jsonResponse({}) });

    expect('post' in client).toBe(false);
    expect('put' in client).toBe(false);
    expect('patch' in client).toBe(false);
    expect('delete' in client).toBe(false);
  });

  it('throws connector_failed for non-2xx responses', async () => {
    const client = new EtsyOpenApiClient({
      config: config(),
      tokenProvider: tokenProvider(),
      fetchImpl: async () => jsonResponse({ error: 'nope' }, { status: 500 }),
    });

    await expect(client.getJson('/listings/123')).rejects.toMatchObject({
      code: 'connector_failed',
      message: 'Etsy Open API request failed: 500',
    } satisfies Partial<AppError>);
  });

  it('repository exposes normalized read-only listing evidence and transactions', async () => {
    const client = new EtsyOpenApiClient({
      config: config(),
      tokenProvider: tokenProvider(),
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('/transactions')) {
          return jsonResponse({ results: [{ transaction_id: 1 }] });
        }

        return jsonResponse({
          listing_id: 123,
          user_id: 456,
          title: 'Printable Weekly Planner',
          price: { amount: 700, divisor: 100, currency_code: 'USD' },
        });
      },
    });
    const repository = createEtsyEvidenceRepository({ client, now: () => '2026-08-12T00:00:00.000Z' });

    await expect(repository.getListingEvidence('123')).resolves.toMatchObject({
      listingId: '123',
      title: 'Printable Weekly Planner',
      source: 'etsy',
    });
    await expect(repository.getListingTransactions('123')).resolves.toEqual([{ transaction_id: 1 }]);
    expect('saveListingEvidence' in repository).toBe(false);
  });

  it('validates a configured connection without returning credentials', async () => {
    const result = await validateEtsyConnection({
      env: env(),
      listingId: '123',
      tokenProvider: tokenProvider(),
      fetchImpl: async () =>
        jsonResponse({
          listing_id: 123,
          user_id: 456,
          title: 'Printable Weekly Planner',
          price: { amount: 700, divisor: 100, currency_code: 'USD' },
        }),
    });

    expect(result).toEqual({ ok: true, listingId: '123', title: 'Printable Weekly Planner' });
    expect(JSON.stringify(result)).not.toMatch(/test-api-key|test-token|secret/iu);
  });
});

function config(): EtsyConnectorConfig {
  return {
    apiKey: 'test-api-key',
    oauthClientId: 'test-client-id',
    oauthRedirectUri: 'http://localhost:3000/oauth/etsy/callback',
    tokenStoragePath: '.local/etsy-token.json',
    scopes: ['shops_r', 'listings_r', 'transactions_r'],
  };
}

function env(): NodeJS.ProcessEnv {
  return {
    ETSY_API_KEY: 'test-api-key',
    ETSY_API_SECRET: 'do-not-return',
    ETSY_OAUTH_CLIENT_ID: 'test-client-id',
    ETSY_OAUTH_REDIRECT_URI: 'http://localhost:3000/oauth/etsy/callback',
    ETSY_OAUTH_SCOPES: 'shops_r listings_r transactions_r',
    ETSY_TOKEN_STORAGE_PATH: '.local/etsy-token.json',
  };
}

function tokenProvider(): EtsyTokenProvider {
  return {
    async getAccessToken() {
      return 'test-token';
    },
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}
