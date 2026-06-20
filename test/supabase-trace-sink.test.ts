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
    sink.emit({ type: 'step', capabilityId: 'rag', role: 'assistant', content: 'thinking out loud', timestamp: '' });
    sink.emit({ type: 'tool_call_end', capabilityId: 'rag', toolName: 'search_knowledge_base', result: { results: [] }, durationMs: 5, timestamp: '' });
    await sink.flush();

    const { rows } = await pool.query(
      'select role from agents.messages where conversation_id = $1 order by created_at', [conversationId]);
    const roles = rows.map((r) => r.role);
    assert.ok(roles.includes('assistant'));
    assert.ok(roles.includes('tool'));
  });

  it('captures the full event signal, not just role + content', async () => {
    const conversationId = await startConversation(pool, 'test');
    const sink = new SupabaseTraceSink({ pool, conversationId });
    // emit one of every event type the loop produces
    sink.emit({ type: 'tool_call_start', capabilityId: 'rag', toolName: 'search_knowledge_base', args: { query: 'rag' }, timestamp: '2026-06-20T00:00:01.000Z' });
    sink.emit({ type: 'tool_call_end', capabilityId: 'rag', toolName: 'search_knowledge_base', result: { results: [] }, error: 'boom', durationMs: 42, timestamp: '2026-06-20T00:00:02.000Z' });
    sink.emit({ type: 'model_usage', capabilityId: 'rag', provider: 'gemma', model: 'gemma2:9b', inputTokens: 100, outputTokens: 23, timestamp: '2026-06-20T00:00:03.000Z' });
    sink.emit({ type: 'warning', capabilityId: 'rag', message: 'low confidence', timestamp: '2026-06-20T00:00:04.000Z' });
    sink.emit({ type: 'error', capabilityId: 'rag', message: 'tool failed', timestamp: '2026-06-20T00:00:05.000Z' });
    await sink.flush();

    const { rows } = await pool.query(
      `select role, content, tool_calls, tool_results, model, tokens_used, created_at
       from agents.messages where conversation_id = $1 order by created_at`, [conversationId]);
    const byRole = Object.fromEntries(rows.map((r) => [r.role, r]));

    // tool_call_start args are captured (the "cause")
    assert.deepEqual(byRole.tool_call.tool_calls, { toolName: 'search_knowledge_base', args: { query: 'rag' } });
    // tool_call_end keeps durationMs + error (previously discarded)
    assert.equal(byRole.tool.tool_results.durationMs, 42);
    assert.equal(byRole.tool.tool_results.error, 'boom');
    // model_usage fills the orphaned tokens_used column + model
    assert.equal(byRole.model_usage.tokens_used, 123);
    assert.match(byRole.model_usage.model, /gemma2:9b/);
    // warning + error events are recorded at all (previously dropped)
    assert.equal(byRole.warning.content, 'low confidence');
    assert.equal(byRole.error.content, 'tool failed');
    // created_at uses the event timestamp, so replay order matches emit order
    const order = rows.map((r) => r.role);
    assert.deepEqual(order, ['tool_call', 'tool', 'model_usage', 'warning', 'error']);
  });
});
