import type { HttpClient, HttpRequest, HttpResponse } from '../../connectors/merchgrid/source.js';

export const completedMerchGridWindow = {
  date: '2026-08-21',
  startInclusive: '2026-08-21T00:00:00.000Z',
  endExclusive: '2026-08-22T00:00:00.000Z',
} as const;

export function posthogAggregateResponse(rows: readonly [string, number][]) {
  return {
    columns: ['event', 'count'],
    results: rows,
  };
}

export class FakeHttpClient implements HttpClient {
  readonly requests: HttpRequest[] = [];
  private response: HttpResponse<unknown> | undefined;
  private failure: unknown;

  respond(response: HttpResponse<unknown>): void {
    this.response = response;
    this.failure = undefined;
  }

  reject(failure: unknown): void {
    this.failure = failure;
    this.response = undefined;
  }

  async request<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    this.requests.push(request);
    if (this.failure !== undefined) {
      throw this.failure;
    }
    if (!this.response) {
      throw new Error('Fake HTTP response was not configured');
    }
    return this.response as HttpResponse<T>;
  }
}
