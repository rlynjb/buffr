import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryCache } from '../src/cache/index.js';
import { CachedEmbeddingProvider } from '../src/retrieval/cached-embedding-provider.js';
import type { EmbeddingProvider } from '../src/retrieval/contracts.js';

function makeStub(calls: string[][]): EmbeddingProvider {
  return {
    id: 'stub',
    dimension: 2,
    async embed(texts: string[]) {
      calls.push([...texts]);
      return texts.map(() => [1, 0]);
    },
  };
}

describe('CachedEmbeddingProvider', () => {
  it('exposes id and dimension from the inner provider', () => {
    const p = new CachedEmbeddingProvider(makeStub([]), new InMemoryCache());
    assert.strictEqual(p.id, 'stub');
    assert.strictEqual(p.dimension, 2);
  });

  it('forwards embed call on cache miss', async () => {
    const calls: string[][] = [];
    const p = new CachedEmbeddingProvider(makeStub(calls), new InMemoryCache());
    const result = await p.embed(['hello']);
    assert.deepStrictEqual(result, [[1, 0]]);
    assert.strictEqual(calls.length, 1);
  });

  it('returns cached result on repeated call for same text', async () => {
    const calls: string[][] = [];
    const p = new CachedEmbeddingProvider(makeStub(calls), new InMemoryCache());
    await p.embed(['hello']);
    const result = await p.embed(['hello']);
    assert.strictEqual(calls.length, 1); // inner called only once
    assert.deepStrictEqual(result, [[1, 0]]);
  });

  it('only sends cache-miss texts to the inner provider in a batch', async () => {
    const calls: string[][] = [];
    const p = new CachedEmbeddingProvider(makeStub(calls), new InMemoryCache());
    await p.embed(['a', 'b']);    // both miss → inner called with ['a', 'b']
    await p.embed(['b', 'c']);   // 'b' hits, 'c' misses → inner called with ['c']
    assert.deepStrictEqual(calls[1], ['c']);
  });

  it('preserves output order when mixing cache hits and misses', async () => {
    const calls: string[][] = [];
    const p = new CachedEmbeddingProvider(makeStub(calls), new InMemoryCache());
    await p.embed(['x', 'y']);
    const result = await p.embed(['x', 'z', 'y']); // x=hit, z=miss, y=hit
    assert.strictEqual(result.length, 3);
    for (const vec of result) assert.deepStrictEqual(vec, [1, 0]);
  });
});
