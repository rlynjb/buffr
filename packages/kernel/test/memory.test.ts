import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createConversationMemory } from '../src/memory/index.js';
import { InMemoryVectorStore } from '../src/retrieval/in-memory-vector-store.js';
import type { EmbeddingProvider } from '../src/retrieval/contracts.js';

const stubEmbedder: EmbeddingProvider = {
  id: 'stub', dimension: 2,
  async embed(texts) { return texts.map(() => [1, 0]); },
};

describe('createConversationMemory', () => {
  it('throws when embedder and store dimensions differ', () => {
    const store = new InMemoryVectorStore(3);
    assert.throws(() => createConversationMemory({ embedder: stubEmbedder, store }), /dimension/);
  });

  it('remembers a turn and recalls it by query', async () => {
    const store = new InMemoryVectorStore(2);
    const memory = createConversationMemory({ embedder: stubEmbedder, store });
    await memory.remember({ conversationId: 'c1', question: 'what is x?', answer: 'x is 42' });
    const hits = await memory.recall('x', 5);
    assert.strictEqual(hits.length, 1);
    assert.ok(hits[0]!.text.includes('x is 42'));
  });

  it('does not mix memory hits with non-memory vectors in the store', async () => {
    const store = new InMemoryVectorStore(2);
    await store.upsert([{ id: 'doc:1', vector: [1, 0], meta: { kind: 'document', text: 'some doc' } }]);
    const memory = createConversationMemory({ embedder: stubEmbedder, store });
    await memory.remember({ conversationId: 'c1', question: 'q', answer: 'a' });
    const hits = await memory.recall('q', 10);
    assert.ok(hits.every((h) => !h.id.startsWith('doc:')), 'recall should not return document chunks');
  });
});
