import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { config as loadEnv } from 'dotenv';
import { createPool } from '../src/db.js';
import { runMigration } from '../src/migrate.js';
import { loadProfile } from '../src/profile.js';

loadEnv();
const url = process.env.DATABASE_URL;

describe('loadProfile', { skip: url ? false : 'set DATABASE_URL to run' }, () => {
  let pool: ReturnType<typeof createPool>;
  before(async () => {
    pool = createPool(url!);
    await runMigration(pool, await readFile(new URL('../../sql/001_agents_schema.sql', import.meta.url), 'utf8'));
    await pool.query("delete from agents.profiles where app_id = 'test'");
  });
  after(async () => { await pool.end(); });

  it('returns the stored profile content, or empty string when none', async () => {
    assert.equal(await loadProfile(pool, 'test'), '');
    await pool.query("insert into agents.profiles (app_id, content) values ('test', 'I prefer terse answers.')");
    assert.match(await loadProfile(pool, 'test'), /terse/);
  });
});
