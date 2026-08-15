import { AppError } from '../../core/errors.js';
import type { EtsyConnectorConfig } from '../../core/config.js';
import type { EtsyTokenProvider } from './auth.js';

export type EtsyHttpClient = {
  getJson<T>(path: string, query?: Record<string, string | number | boolean>): Promise<T>;
};

export class EtsyOpenApiClient implements EtsyHttpClient {
  private readonly config: EtsyConnectorConfig;
  private readonly tokenProvider: EtsyTokenProvider;
  private readonly fetchImpl: typeof fetch;

  constructor(input: { config: EtsyConnectorConfig; tokenProvider: EtsyTokenProvider; fetchImpl?: typeof fetch }) {
    this.config = input.config;
    this.tokenProvider = input.tokenProvider;
    this.fetchImpl = input.fetchImpl ?? fetch;
  }

  async getJson<T>(path: string, query: Record<string, string | number | boolean> = {}): Promise<T> {
    const accessToken = await this.tokenProvider.getAccessToken();
    const url = new URL(`https://openapi.etsy.com/v3/application/${path.replace(/^\/+/u, '')}`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }

    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'x-api-key': this.config.apiKey,
        accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new AppError('connector_failed', `Etsy Open API request failed: ${response.status}`);
    }

    return (await response.json()) as T;
  }
}
