// packages/kernel/src/retrieval/contracts.ts

export type VectorChunk = {
  id: string;
  vector: number[];
  meta: Record<string, unknown>;
};

export type VectorHit = {
  id: string;
  score: number;
  meta: Record<string, unknown>;
};

export type EmbeddingProvider = {
  id: string;
  dimension: number;
  embed(texts: string[]): Promise<number[][]>;
};

export type VectorStore = {
  dimension: number;
  upsert(chunks: VectorChunk[]): Promise<void>;
  search(vector: number[], k: number): Promise<VectorHit[]>;
};
