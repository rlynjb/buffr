// packages/kernel/src/retrieval/pipeline.ts
import { chunkText } from './chunker.js';
import type { EmbeddingProvider, VectorHit, VectorStore } from './contracts.js';

export type RetrievalDocument = { id: string; text: string; meta?: Record<string, unknown> };
export type RetrievalWiring = { embedder: EmbeddingProvider; store: VectorStore };

export type RetrievalPipeline = {
  embedder: EmbeddingProvider;
  store: VectorStore;
  index(doc: RetrievalDocument): Promise<void>;
  query(query: string, topK?: number): Promise<VectorHit[]>;
};

function assertWiring(wiring: RetrievalWiring): void {
  if (wiring.embedder.dimension !== wiring.store.dimension) {
    throw new Error(
      `dimension mismatch: embedder "${wiring.embedder.id}" is ${wiring.embedder.dimension}-dim ` +
      `but store is ${wiring.store.dimension}-dim`,
    );
  }
}

export async function indexDocument(doc: RetrievalDocument, wiring: RetrievalWiring): Promise<void> {
  assertWiring(wiring);
  const texts = chunkText(doc.text);
  if (texts.length === 0) return;
  const vectors = await wiring.embedder.embed(texts);
  const chunks = texts.map((text, i) => ({
    id: `${doc.id}#${i}`,
    vector: vectors[i]!,
    meta: { ...(doc.meta ?? {}), docId: doc.id, chunkIndex: i, text },
  }));
  await wiring.store.upsert(chunks);
}

export async function queryKnowledgeBase(query: string, wiring: RetrievalWiring, topK = 5): Promise<VectorHit[]> {
  assertWiring(wiring);
  const [vector] = await wiring.embedder.embed([query]);
  if (!vector) return [];
  return wiring.store.search(vector, topK);
}

export function createRetrievalPipeline(wiring: RetrievalWiring): RetrievalPipeline {
  assertWiring(wiring);
  return {
    embedder: wiring.embedder,
    store: wiring.store,
    index: (doc) => indexDocument(doc, wiring),
    query: (query, topK) => queryKnowledgeBase(query, wiring, topK),
  };
}
