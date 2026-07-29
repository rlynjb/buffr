import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CachedConnector } from '../../src/cached-connector.js';

// Minimal in-test cache — no import from @buffr/kernel needed.
function makeCache<V>() {
  const store = new Map<string, { value: V; expiresAt: number | null }>();
  return {
    get(key: string): V | undefined {
      const e = store.get(key);
      if (!e) return undefined;
      if (e.expiresAt !== null && Date.now() > e.expiresAt) { store.delete(key); return undefined; }
      return e.value;
    },
    set(key: string, value: V, ttlMs?: number): void {
      store.set(key, { value, expiresAt: ttlMs !== undefined ? Date.now() + ttlMs : null });
    },
  };
}

function makeConnector<P>(calls: P[]) {
  return {
    id: 'stub',
    async fetch(params: P) {
      calls.push(params);
      return {
        data: `result:${JSON.stringify(params)}`,
        fetchedAt: 'now',
        sourceId: 'stub',
        toEvidence: () => [],
      };
    },
  };
}

describe('CachedConnector', () => {
  it('exposes the inner connector id', () => {
    const c = new CachedConnector(makeConnector([]), makeCache());
    assert.strictEqual(c.id, 'stub');
  });

  it('forwards the first fetch to the inner connector', async () => {
    const calls: object[] = [];
    const c = new CachedConnector(makeConnector(calls), makeCache());
    const result = await c.fetch({ q: 'hello' });
    assert.strictEqual(result.data, 'result:{"q":"hello"}');
    assert.strictEqual(calls.length, 1);
  });

  it('returns cached result on second fetch with same params', async () => {
    const calls: object[] = [];
    const c = new CachedConnector(makeConnector(calls), makeCache());
    await c.fetch({ q: 'hello' });
    const second = await c.fetch({ q: 'hello' });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(second.data, 'result:{"q":"hello"}');
  });

  it('calls inner connector for different params', async () => {
    const calls: object[] = [];
    const c = new CachedConnector(makeConnector(calls), makeCache());
    await c.fetch({ q: 'hello' });
    await c.fetch({ q: 'world' });
    assert.strictEqual(calls.length, 2);
  });

  it('calls inner connector again after TTL expires', async () => {
    const calls: object[] = [];
    const c = new CachedConnector(makeConnector(calls), makeCache(), 1); // 1 ms TTL
    await c.fetch({ q: 'hi' });
    await new Promise<void>(r => setTimeout(r, 10));
    await c.fetch({ q: 'hi' });
    assert.strictEqual(calls.length, 2);
  });
});
