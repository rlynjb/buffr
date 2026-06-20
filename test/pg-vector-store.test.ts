import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach } from 'node:test';
import { readFile } from 'node:fs/promises';
import { config as loadEnv } from 'dotenv';
import { createPool } from '../src/db.js';
import { runMigration } from '../src/migrate.js';
import { PgVectorStore } from '../src/pg-vector-store.js';

loadEnv();
const url = process.env.DATABASE_URL;

describe('PgVectorStore', { skip: url ? false : 'set DATABASE_URL to run' }, () => {
  let pool: ReturnType<typeof createPool>;
  before(async () => {
    pool = createPool(url!);
    const sql = await readFile(new URL('../../sql/001_agents_schema.sql', import.meta.url), 'utf8');
    await runMigration(pool, sql);
  });
  beforeEach(async () => {
    await pool.query("delete from agents.chunks where app_id = 'test'");
  });
  after(async () => { await pool.end(); });

  function vec(seed: number): number[] {
    const v = new Array(768).fill(0);
    v[seed] = 1;
    return v;
  }

  it('upserts and ranks the planted chunk on top', async () => {
    const store = new PgVectorStore({ pool, appId: 'test' });
    await store.upsert([
      { id: 'planted#0', vector: vec(5), meta: { docId: 'planted', chunkIndex: 0, text: 'the planted passage' } },
      { id: 'other#0', vector: vec(200), meta: { docId: 'other', chunkIndex: 0, text: 'unrelated passage' } },
    ]);
    const hits = await store.search(vec(5), 2);
    assert.equal(hits[0]?.id, 'planted#0');
    assert.equal(hits[0]?.meta.text, 'the planted passage');
    assert.ok(hits[0]!.score >= hits[1]!.score);
  });

  it('throws on a dimension mismatch', async () => {
    const store = new PgVectorStore({ pool, appId: 'test' });
    await assert.rejects(() => store.upsert([{ id: 'x#0', vector: [1, 2, 3], meta: {} }]), /dimension/);
    await assert.rejects(() => store.search([1, 2, 3], 1), /dimension/);
  });
});
