import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryCache } from '../src/cache/index.js';

describe('InMemoryCache', () => {
  it('returns undefined for missing key', () => {
    const cache = new InMemoryCache<string, number>();
    assert.strictEqual(cache.get('missing'), undefined);
  });

  it('stores and retrieves a value', () => {
    const cache = new InMemoryCache<string, number>();
    cache.set('a', 42);
    assert.strictEqual(cache.get('a'), 42);
  });

  it('returns undefined after TTL expires', async () => {
    const cache = new InMemoryCache<string, number>();
    cache.set('x', 1, 1); // 1 ms TTL
    await new Promise<void>(r => setTimeout(r, 10));
    assert.strictEqual(cache.get('x'), undefined);
  });

  it('does not expire entry without TTL', async () => {
    const cache = new InMemoryCache<string, number>();
    cache.set('y', 2);
    await new Promise<void>(r => setTimeout(r, 10));
    assert.strictEqual(cache.get('y'), 2);
  });

  it('deletes a specific key', () => {
    const cache = new InMemoryCache<string, number>();
    cache.set('a', 1);
    cache.delete('a');
    assert.strictEqual(cache.get('a'), undefined);
  });

  it('clears all entries', () => {
    const cache = new InMemoryCache<string, number>();
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    assert.strictEqual(cache.size(), 0);
  });

  it('size() counts live entries only', async () => {
    const cache = new InMemoryCache<string, number>();
    cache.set('permanent', 1);
    cache.set('expiring', 2, 1);
    await new Promise<void>(r => setTimeout(r, 10));
    cache.get('expiring'); // triggers eviction
    assert.strictEqual(cache.size(), 1);
  });
});
