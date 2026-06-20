import pg from 'pg';
import type { VectorStore } from '@rlynjb/aptkit-core';

type Chunk = { id: string; vector: number[]; meta: Record<string, unknown> };
type Hit = { id: string; score: number; meta: Record<string, unknown> };

export type PgVectorStoreOptions = {
  pool: pg.Pool;
  appId?: string;
  embeddingModel?: string;
  dimension?: number;
};

/** Serialize a JS number[] into pgvector's text literal: [0.1,0.2,...]. */
function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

export class PgVectorStore implements VectorStore {
  readonly dimension: number;
  private readonly pool: pg.Pool;
  private readonly appId: string;
  private readonly embeddingModel: string;

  constructor(opts: PgVectorStoreOptions) {
    this.pool = opts.pool;
    this.appId = opts.appId ?? 'laptop';
    this.embeddingModel = opts.embeddingModel ?? 'nomic-embed-text:v1.5';
    this.dimension = opts.dimension ?? 768;
  }

  private assertDim(v: number[]): void {
    if (v.length !== this.dimension) {
      throw new Error(`dimension mismatch: got ${v.length}, store is ${this.dimension}`);
    }
  }

  async upsert(chunks: Chunk[]): Promise<void> {
    for (const c of chunks) this.assertDim(c.vector);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      for (const c of chunks) {
        const docId = typeof c.meta.docId === 'string' ? c.meta.docId : null;
        const chunkIndex = typeof c.meta.chunkIndex === 'number' ? c.meta.chunkIndex : 0;
        const content = typeof c.meta.text === 'string' ? c.meta.text : '';
        await client.query(
          `insert into agents.chunks (id, document_id, app_id, chunk_index, content, embedding, embedding_model, meta)
           values ($1, $2, $3, $4, $5, $6::vector, $7, $8)
           on conflict (id) do update set
             document_id = excluded.document_id, app_id = excluded.app_id,
             chunk_index = excluded.chunk_index, content = excluded.content,
             embedding = excluded.embedding, embedding_model = excluded.embedding_model,
             meta = excluded.meta`,
          [c.id, docId, this.appId, chunkIndex, content, toVectorLiteral(c.vector), this.embeddingModel, c.meta],
        );
      }
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }

  async search(vector: number[], k: number): Promise<Hit[]> {
    this.assertDim(vector);
    // <=> is cosine DISTANCE; cosine similarity score = 1 - distance.
    const { rows } = await this.pool.query(
      `select id, content, chunk_index, document_id, meta,
              1 - (embedding <=> $1::vector) as score
       from agents.chunks
       where app_id = $2
       order by embedding <=> $1::vector
       limit $3`,
      [toVectorLiteral(vector), this.appId, k],
    );
    // Rebuild the in-memory meta shape so the search_knowledge_base tool's citations work.
    return rows.map((r) => ({
      id: r.id,
      score: Number(r.score),
      meta: { ...(r.meta ?? {}), docId: r.document_id, chunkIndex: r.chunk_index, text: r.content },
    }));
  }
}
