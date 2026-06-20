import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { config as loadEnv } from 'dotenv';
import { createPool } from '../src/db.js';
import { runMigration } from '../src/migrate.js';

loadEnv();
const url = process.env.DATABASE_URL;

describe('agents schema migration', { skip: url ? false : 'set DATABASE_URL to run' }, () => {
  let pool: ReturnType<typeof createPool>;
  before(() => { pool = createPool(url!); });
  after(async () => { await pool.end(); });

  it('creates the agents tables idempotently', async () => {
    const sql = await readFile(new URL('../../sql/001_agents_schema.sql', import.meta.url), 'utf8');
    await runMigration(pool, sql);
    await runMigration(pool, sql); // idempotent — runs twice without error
    const { rows } = await pool.query(
      `select table_name from information_schema.tables where table_schema = 'agents' order by table_name`,
    );
    const names = rows.map((r) => r.table_name);
    for (const t of ['chunks', 'conversations', 'documents', 'messages', 'profiles']) {
      assert.ok(names.includes(t), `missing table ${t}`);
    }
  });
});
