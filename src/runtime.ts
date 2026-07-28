import pg from 'pg';
import type { RetrievalPipeline } from '@buffr/kernel';

/** Writes the source-of-truth documents row, then indexes its chunks. */
export async function indexDocumentRow(
  pool: pg.Pool,
  appId: string,
  pipeline: RetrievalPipeline,
  doc: { id: string; text: string; sourcePath?: string; sourceType?: string },
): Promise<void> {
  const sourceType = doc.sourceType ?? 'markdown';
  await pool.query(
    `insert into agents.documents (id, app_id, source_type, source_path, content)
     values ($1, $2, $3, $4, $5)
     on conflict (id) do update set content = excluded.content, source_path = excluded.source_path`,
    [doc.id, appId, sourceType, doc.sourcePath ?? null, doc.text],
  );
  await pipeline.index({ id: doc.id, text: doc.text });
}
