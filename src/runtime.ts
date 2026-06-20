import pg from 'pg';
import type { RetrievalPipeline } from '@aptkit/retrieval';

/** Writes the source-of-truth documents row, then indexes its chunks. */
export async function indexDocumentRow(
  pool: pg.Pool,
  appId: string,
  pipeline: RetrievalPipeline,
  doc: { id: string; text: string; sourcePath?: string },
): Promise<void> {
  await pool.query(
    `insert into agents.documents (id, app_id, source_type, source_path, content)
     values ($1, $2, 'markdown', $3, $4)
     on conflict (id) do update set content = excluded.content, source_path = excluded.source_path`,
    [doc.id, appId, doc.sourcePath ?? null, doc.text],
  );
  await pipeline.index({ id: doc.id, text: doc.text });
}
