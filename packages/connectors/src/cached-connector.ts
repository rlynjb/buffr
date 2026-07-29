import type { DataConnector, ConnectorResult, FetchOptions } from './contracts.js';

// Duck-typed cache slot — no import from @buffr/kernel required.
// InMemoryCache<string, ConnectorResult<D>> satisfies this shape.
type CacheSlot<V> = {
  get(key: string): V | undefined;
  set(key: string, value: V, ttlMs?: number): void;
};

export class CachedConnector<P, D> implements DataConnector<P, D> {
  readonly id: string;

  constructor(
    private readonly inner: DataConnector<P, D>,
    private readonly cache: CacheSlot<ConnectorResult<D>>,
    private readonly ttlMs: number = 60 * 60 * 1000, // 1 hour default
  ) {
    this.id = inner.id;
  }

  async fetch(params: P, options?: FetchOptions): Promise<ConnectorResult<D>> {
    const key = JSON.stringify(params);
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const result = await this.inner.fetch(params, options);
    this.cache.set(key, result, this.ttlMs);
    return result;
  }
}
