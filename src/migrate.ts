import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { config as loadEnv } from 'dotenv';
import { loadConfig } from './config.js';
import { createPool } from './db.js';

const MIGRATION_FILES = ['001_agents_schema.sql', '002_decision_journal.sql'];

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

/** Runs every numbered migration file in sql/, in order. */
export async function runAllMigrations(pool: pg.Pool): Promise<void> {
  for (const file of MIGRATION_FILES) {
    const sql = await readFile(new URL(`../../sql/${file}`, import.meta.url), 'utf8');
    await runMigration(pool, sql);
  }
}

// CLI entry: `npm run migrate`
if (import.meta.url === `file://${process.argv[1]}`) {
  loadEnv();
  const cfg = loadConfig(process.env);
  if (!cfg.databaseUrl) throw new Error('DATABASE_URL is not set (see .env)');
  const pool = createPool(cfg.databaseUrl);
  await runAllMigrations(pool);
  await pool.end();
  process.stdout.write('migrations applied\n');
}
