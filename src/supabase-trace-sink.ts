import pg from 'pg';
import type { CapabilityTraceSink, CapabilityEvent } from '@aptkit/runtime';

export async function startConversation(pool: pg.Pool, appId: string, agentName = 'rag-query-agent'): Promise<string> {
  const { rows } = await pool.query(
    'insert into agents.conversations (app_id, agent_name) values ($1, $2) returning id', [appId, agentName]);
  return rows[0].id as string;
}

export async function persistMessage(
  pool: pg.Pool, conversationId: string, role: string, content: string,
  extra?: { toolResults?: unknown; model?: string },
): Promise<void> {
  await pool.query(
    `insert into agents.messages (conversation_id, role, content, tool_results, model)
     values ($1, $2, $3, $4, $5)`,
    [conversationId, role, content, extra?.toolResults ?? null, extra?.model ?? null],
  );
}

/** Captures the agent's trajectory. emit() is sync (aptkit's contract); writes
 *  are queued and awaited via flush() after the run. */
export class SupabaseTraceSink implements CapabilityTraceSink {
  private readonly pending: Promise<void>[] = [];
  constructor(private readonly opts: { pool: pg.Pool; conversationId: string }) {}

  emit(event: CapabilityEvent): void {
    const { pool, conversationId } = this.opts;
    if (event.type === 'step' && event.role === 'assistant' && event.content) {
      this.pending.push(persistMessage(pool, conversationId, 'assistant', event.content));
    } else if (event.type === 'tool_call_end') {
      this.pending.push(
        persistMessage(pool, conversationId, 'tool', event.toolName, { toolResults: event.result }));
    }
  }

  async flush(): Promise<void> {
    await Promise.all(this.pending);
  }
}
