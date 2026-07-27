import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText, InMemoryVectorStore, createRetrievalPipeline } from '../src/retrieval/index.js';
import type { EmbeddingProvider } from '../src/retrieval/index.js';

describe('chunkText', () => {
  it('returns empty array for empty string', () => {
    assert.deepStrictEqual(chunkText(''), []);
  });

  it('returns single chunk when text fits in one window', () => {
    const chunks = chunkText('hello world');
    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(chunks[0], 'hello world');
  });

  it('produces overlapping chunks for long text', () => {
    const text = 'a'.repeat(600);
    const chunks = chunkText(text);
    assert.ok(chunks.length > 1, 'should produce multiple chunks');
    assert.ok(chunks[0]!.length <= 512);
  });
});

describe('InMemoryVectorStore', () => {
  it('searches and returns ranked hits', async () => {
    const store = new InMemoryVectorStore(2);
    await store.upsert([
      { id: 'a', vector: [1, 0], meta: { text: 'hello' } },
      { id: 'b', vector: [0, 1], meta: { text: 'world' } },
    ]);
    const hits = await store.search([1, 0], 2);
    assert.strictEqual(hits[0]!.id, 'a');
    assert.ok(hits[0]!.score > hits[1]!.score);
  });

  it('throws on dimension mismatch', async () => {
    const store = new InMemoryVectorStore(2);
    await assert.rejects(() => store.upsert([{ id: 'x', vector: [1], meta: {} }]), /dimension mismatch/);
  });
});

describe('createRetrievalPipeline', () => {
  const stubEmbedder: EmbeddingProvider = {
    id: 'stub', dimension: 2,
    async embed(texts) { return texts.map(() => [1, 0]); },
  };

  it('throws on dimension mismatch between embedder and store', () => {
    const store = new InMemoryVectorStore(3);
    assert.throws(() => createRetrievalPipeline({ embedder: stubEmbedder, store }), /dimension mismatch/);
  });

  it('indexes and queries successfully', async () => {
    const store = new InMemoryVectorStore(2);
    const pipeline = createRetrievalPipeline({ embedder: stubEmbedder, store });
    await pipeline.index({ id: 'doc1', text: 'hello world this is a document' });
    const hits = await pipeline.query('hello', 5);
    assert.ok(hits.length > 0);
  });
});
