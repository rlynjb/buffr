import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { config as loadEnv } from 'dotenv';
import { loadConfig } from './config.js';
import { createPool } from './db.js';

/** Runs a SQL script in one transaction. */
export async function runMigration(pool: pg.Pool, sql: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(sql);
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

// CLI entry: `npm run migrate`
if (import.meta.url === `file://${process.argv[1]}`) {
  loadEnv();
  const cfg = loadConfig(process.env);
  if (!cfg.databaseUrl) throw new Error('DATABASE_URL is not set (see .env)');
  const pool = createPool(cfg.databaseUrl);
  const sql = await readFile(new URL('../../sql/001_agents_schema.sql', import.meta.url), 'utf8');
  await runMigration(pool, sql);
  await pool.end();
  process.stdout.write('migration applied\n');
}
