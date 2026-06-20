import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach } from 'node:test';
import { readFile } from 'node:fs/promises';
import { config as loadEnv } from 'dotenv';
import { createPool } from '../src/db.js';
import { runMigration } from '../src/migrate.js';
import { startConversation, SupabaseTraceSink } from '../src/supabase-trace-sink.js';

loadEnv();
const url = process.env.DATABASE_URL;

describe('SupabaseTraceSink', { skip: url ? false : 'set DATABASE_URL to run' }, () => {
  let pool: ReturnType<typeof createPool>;
  before(async () => {
    pool = createPool(url!);
    await runMigration(pool, await readFile(new URL('../../sql/001_agents_schema.sql', import.meta.url), 'utf8'));
  });
  beforeEach(async () => {
    await pool.query("delete from agents.conversations where app_id = 'test'");
  });
  after(async () => { await pool.end(); });

  it('persists assistant steps and tool results as messages', async () => {
    const conversationId = await startConversation(pool, 'test');
    const sink = new SupabaseTraceSink({ pool, conversationId });
    sink.emit({ type: 'step', capabilityId: 'rag', role: 'assistant', content: 'thinking out loud', timestamp: '' } as never);
    sink.emit({ type: 'tool_call_end', capabilityId: 'rag', toolName: 'search_knowledge_base', result: { results: [] }, durationMs: 5, timestamp: '' } as never);
    await sink.flush();

    const { rows } = await pool.query(
      'select role from agents.messages where conversation_id = $1 order by created_at', [conversationId]);
    const roles = rows.map((r) => r.role);
    assert.ok(roles.includes('assistant'));
    assert.ok(roles.includes('tool'));
  });
});
