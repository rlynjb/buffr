import pg from 'pg';
import type { CapabilityTraceSink, CapabilityEvent } from '@rlynjb/aptkit-core';

export async function startConversation(pool: pg.Pool, appId: string, agentName = 'rag-query-agent'): Promise<string> {
  const { rows } = await pool.query(
    'insert into agents.conversations (app_id, agent_name) values ($1, $2) returning id', [appId, agentName]);
  return rows[0].id as string;
}

type MessageExtra = {
  toolCalls?: unknown;
  toolResults?: unknown;
  model?: string;
  tokensUsed?: number;
  /** ISO timestamp from the event; falls back to server now() when empty/absent. */
  createdAt?: string;
};

export async function persistMessage(
  pool: pg.Pool, conversationId: string, role: string, content: string,
  extra?: MessageExtra,
): Promise<void> {
  // jsonb columns are stringified explicitly so array payloads aren't mistaken
  // for a Postgres array literal by node-postgres.
  const toJsonb = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));
  const createdAt = extra?.createdAt && extra.createdAt.length > 0 ? extra.createdAt : null;
  await pool.query(
    `insert into agents.messages
       (conversation_id, role, content, tool_calls, tool_results, model, tokens_used, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::timestamptz, now()))`,
    [
      conversationId, role, content,
      toJsonb(extra?.toolCalls), toJsonb(extra?.toolResults),
      extra?.model ?? null, extra?.tokensUsed ?? null, createdAt,
    ],
  );
}

/** Captures the agent's trajectory. emit() is sync (aptkit's contract); writes
 *  are queued and awaited via flush() after the run.
 *
 *  Every CapabilityEvent variant is persisted — not just assistant steps and
 *  tool results. Tool-call args (the cause), durationMs + error, token usage,
 *  and warning/error events were previously dropped on the floor; capturing
 *  them turns `agents.messages` into a complete, replayable trajectory and
 *  fills the otherwise-orphaned `tokens_used` column. The event timestamp is
 *  persisted into `created_at` so replay order matches emit order rather than
 *  the race between concurrent flush inserts. */
export class SupabaseTraceSink implements CapabilityTraceSink {
  private readonly pending: Promise<void>[] = [];
  constructor(private readonly opts: { pool: pg.Pool; conversationId: string }) {}

  emit(event: CapabilityEvent): void {
    const { pool, conversationId } = this.opts;
    const at = event.timestamp;
    switch (event.type) {
      case 'step':
        if (event.content) {
          this.push(persistMessage(pool, conversationId, event.role, event.content, { createdAt: at }));
        }
        return;
      case 'tool_call_start':
        this.push(persistMessage(pool, conversationId, 'tool_call', event.toolName, {
          toolCalls: { toolName: event.toolName, args: event.args }, createdAt: at,
        }));
        return;
      case 'tool_call_end':
        this.push(persistMessage(pool, conversationId, 'tool', event.toolName, {
          toolResults: { result: event.result, error: event.error, durationMs: event.durationMs },
          createdAt: at,
        }));
        return;
      case 'model_usage':
        this.push(persistMessage(pool, conversationId, 'model_usage', '', {
          model: `${event.provider}/${event.model}`,
          tokensUsed: (event.inputTokens ?? 0) + (event.outputTokens ?? 0),
          createdAt: at,
        }));
        return;
      case 'warning':
      case 'error':
        this.push(persistMessage(pool, conversationId, event.type, event.message, { createdAt: at }));
        return;
    }
  }

  private push(p: Promise<void>): void {
    this.pending.push(p);
  }

  async flush(): Promise<void> {
    await Promise.all(this.pending);
  }
}
