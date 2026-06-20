import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach } from 'node:test';
import { readFile } from 'node:fs/promises';
import { config as loadEnv } from 'dotenv';
import { createPool } from '../src/db.js';
import { runMigration } from '../src/migrate.js';
import { indexDocumentRow } from '../src/runtime.js';
import { PgVectorStore } from '../src/pg-vector-store.js';
import { createRetrievalPipeline, type EmbeddingProvider } from '@aptkit/retrieval';

loadEnv();
const url = process.env.DATABASE_URL;

const fakeEmbedder: EmbeddingProvider = {
  id: 'fake', dimension: 768,
  async embed(texts) { return texts.map(() => { const v = new Array(768).fill(0); v[1] = 1; return v; }); },
};

describe('indexDocumentRow', { skip: url ? false : 'set DATABASE_URL to run' }, () => {
  let pool: ReturnType<typeof createPool>;
  before(async () => {
    pool = createPool(url!);
    await runMigration(pool, await readFile(new URL('../../sql/001_agents_schema.sql', import.meta.url), 'utf8'));
  });
  beforeEach(async () => {
    await pool.query("delete from agents.chunks where app_id = 'test'");
    await pool.query("delete from agents.documents where app_id = 'test'");
  });
  after(async () => { await pool.end(); });

  it('writes a documents row and its chunks', async () => {
    const store = new PgVectorStore({ pool, appId: 'test' });
    const pipeline = createRetrievalPipeline({ embedder: fakeEmbedder, store });
    await indexDocumentRow(pool, 'test', pipeline, { id: 'notes/a', text: 'hello world from notes', sourcePath: 'notes/a.md' });

    const docs = await pool.query("select id from agents.documents where id = 'notes/a'");
    assert.equal(docs.rowCount, 1);
    const chunks = await pool.query("select id from agents.chunks where document_id = 'notes/a'");
    assert.ok(chunks.rowCount! >= 1);
  });
});
