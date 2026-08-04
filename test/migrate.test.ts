import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { config as loadEnv } from 'dotenv';
import { createPool } from '../src/db.js';
import { runAllMigrations } from '../src/migrate.js';

loadEnv();
const url = process.env.DATABASE_URL;

describe('agents schema migration', { skip: url ? false : 'set DATABASE_URL to run' }, () => {
  let pool: ReturnType<typeof createPool>;
  before(() => { pool = createPool(url!); });
  after(async () => { await pool.end(); });

  it('creates the agents tables idempotently', async () => {
    await runAllMigrations(pool);
    await runAllMigrations(pool); // idempotent — runs twice without error
    const { rows } = await pool.query(
      `select table_name from information_schema.tables where table_schema = 'agents' order by table_name`,
    );
    const names = rows.map((r) => r.table_name);
    for (const t of ['chunks', 'conversations', 'decisions', 'documents', 'messages', 'profiles']) {
      assert.ok(names.includes(t), `missing table ${t}`);
    }
  });
});
