# Trajectory as memory (per-run capture, not yet cross-session recall)

**Industry name(s):** Trajectory capture / agent run logging / episodic-memory
substrate · *Industry standard (capture) + Project-specific (the thesis)*

---

## Zoom out, then zoom in

Every assistant turn and every tool call the agent makes is written to Postgres
as the run happens. This is buffr's stated differentiator — capture the whole
trajectory now so fine-tuning is *answerable* later. The capture is a sink that
sits beside the loop, listening to its events.

```
  Zoom out — the trace sink beside the loop

  ┌─ Agent loop (aptkit) ─────────────────────────────────────┐
  │  each turn: trace.emit({ step | tool_call_end })          │
  └───────────────────────────────┬───────────────────────────┘
                                  │ emit() (sync, queued)
  ┌─ Trajectory sink (buffr) ─────▼───────────────────────────┐
  │  ★ SupabaseTraceSink ★  → persistMessage(...)             │ ← we are here
  └───────────────────────────────┬───────────────────────────┘
                                  │ INSERT
  ┌─ Storage ─────────────────────▼───────────────────────────┐
  │  agents.conversations · agents.messages                   │
  └────────────────────────────────────────────────────────────┘
```

Zoom in — and here's the honest part. buffr **writes** the trajectory but never
**reads it back** into a later run. It's a one-way recorder: a corpus for future
training and audit, not a memory tier the agent queries. Calling it "memory" is
aspirational; today it's *capture*. The Phase A / Phase B split below makes the
gap explicit.

---

## Structure pass

**Axis: state — who owns the run's record, and is it read back?**

```
  "where does the run's state live, and is it recalled?" — traced out

  ┌──────────────────────────────────────────────┐
  │ in-loop: messages array                       │  → owned by the loop,
  │   working state, gone when run ends            │    lives in RAM
  └──────────────────────────────────────────────┘
      ┌──────────────────────────────────────────┐
      │ sink: SupabaseTraceSink.pending           │  → owned by buffr,
      │   queued promises, flushed after run       │    write-through
      └──────────────────────────────────────────┘
          ┌──────────────────────────────────────┐
          │ db: agents.messages                    │  → durable, but
          │   never queried by a future run        │    WRITE-ONLY today
          └──────────────────────────────────────┘
```

**The seam that matters most:** the missing arrow from `agents.messages` *back
into* a future run's context. That absent seam is the line between "trajectory
capture" (built) and "episodic memory" (not built). Naming it is the point of
this file.

---

## How it works

### Move 1 — the mental model

You know how an analytics SDK fires events as the user clicks around, queued and
flushed in a batch so it doesn't block the UI? The trace sink is that, for the
agent: it listens to loop events, queues a DB write per event, and flushes them
all after the run so persistence never blocks the loop.

```
  The pattern — sync emit, async flush

  loop ──emit(step)──────► sink: pending.push(insert promise)  (sync, non-blocking)
  loop ──emit(tool_end)──► sink: pending.push(insert promise)
  loop ends
  buffr ──flush()────────► await Promise.all(pending)          (now the writes settle)
```

### Move 2 — the mechanism, part by part

**The contract: `emit()` is synchronous.** aptkit's `CapabilityTraceSink`
defines `emit(event): void` — no `await`. Bridge: it's an event listener
callback; it can't block the emitter. So the sink can't write-and-await inline.

**The trick: queue promises, flush later.** `emit` starts the insert and pushes
the *promise* into a `pending` array without awaiting it. After the run,
`flush()` awaits them all. This keeps the loop fast while still guaranteeing the
writes complete before the process exits.

```
  emit(event):
    if event is assistant step with content:
      pending.push( persistMessage(role='assistant', content) )   // don't await
    else if event is tool_call_end:
      pending.push( persistMessage(role='tool', toolName, result) )

  flush():
    await Promise.all(pending)     // settle every queued write
```

What breaks without the flush: `ask-cmd.ts` calls `pool.end()` right after the
run; without `await trace.flush()` first, the queued inserts race the pool
shutdown and some trajectory rows silently never land.

**Two event types become two row shapes.** An assistant `step` event becomes a
`role='assistant'` message; a `tool_call_end` becomes a `role='tool'` message
carrying the tool name and its result JSON. The user's question is persisted
separately, up front, before the agent runs.

```
  Layers-and-hops — events to rows

  ┌─ loop ───────┐ step{role:assistant}   ┌─ sink ───────┐ INSERT  ┌─ db ──────┐
  │ runAgentLoop │ ─────────────────────► │ SupabaseT... │ ──────► │ messages  │
  │              │ tool_call_end{result}  │              │         │ (assistant│
  └──────────────┘ ─────────────────────► └──────────────┘         │  + tool)  │
                                                                    └───────────┘
```

### Move 2.5 — current state vs future state

This concept is built-but-partial. The split is load-bearing here.

```
  Phase A (now): capture            Phase B (planned): recall

  run ──► trajectory ──► DB          new run starts
                          │            │
                       (stops)         ▼
                                   retrieve relevant past
  the arrow ends at the DB.         conversations → inject
  nothing reads it back.            into context → answer
                                       │
                                   the missing arrow today
```

**What's true now:** `ask-cmd.ts:29` starts a *fresh* conversation every
invocation. No prior conversation is loaded. The DB grows; the agent never
consults it.

**What's planned and why it's gated:** the trajectories are explicitly a
*fine-tuning corpus* (`agent-layer-plan.md:17`), and conversation retention is
an open question (`agent-layer-plan.md:118` — "Unbounded growth is a real cost.
Decide TTL / keep-N-recent / archive"). Cross-session recall isn't built because
the project's first goal is to *measure* the single agent, not to grow its
memory.

**What wouldn't have to change:** the capture path. The sink already records
everything episodic memory would need. Phase B adds a *read* path
(retrieve-relevant-conversations → inject into the system prompt) on top of the
existing write path — it doesn't rewrite the sink.

### Move 3 — the principle

Capture before recall. The discipline buffr borrows is "record the full
trajectory from day one so the option to learn from it later stays open" — even
before you've built anything that reads it. The expensive mistake is the
opposite: ship without capture, then wish you had the data when you want to
fine-tune. buffr pays the cheap cost (write-through inserts) now to keep the
expensive option (training on real trajectories) open.

---

## Primary diagram

```
  Trajectory capture in buffr — full recap

  ┌─ ask-cmd.ts ──────────────────────────────────────────────┐
  │ conversationId = startConversation(pool, appId)            │
  │ persistMessage('user', question)        ← the question     │
  │ trace = new SupabaseTraceSink({ pool, conversationId })    │
  │ agent.answer(question)  ─────────┐                         │
  │ await trace.flush()              │ emits during the run    │
  └──────────────────────────────────┼─────────────────────────┘
                                     ▼
  ┌─ SupabaseTraceSink ───────────────────────────────────────┐
  │ emit(step, assistant)    → pending.push(insert assistant)  │
  │ emit(tool_call_end)      → pending.push(insert tool)       │
  │ flush()                  → await Promise.all(pending)       │
  └───────────────────────────────┬───────────────────────────┘
                                  ▼
  ┌─ Postgres (agents schema) ────────────────────────────────┐
  │ conversations(id, app_id, agent_name)                     │
  │ messages(conversation_id, role, content, tool_results)    │
  │   role ∈ { user, assistant, tool }   ← WRITE-ONLY today    │
  └────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

### Use cases

Reached on every run, silently. The wiring in `ask-cmd.ts` opens a conversation,
records the question, attaches the sink, runs the agent, and flushes. The
purpose is downstream: an audit log of what the agent did, and a training corpus
for the Phase-4 fine-tuning decision. It is *not* reached to give the agent
memory of past chats — that path doesn't exist.

### Code, side by side

The sink (`src/supabase-trace-sink.ts:23-39`):

```
export class SupabaseTraceSink implements CapabilityTraceSink {
  private readonly pending: Promise<void>[] = [];      ← queued writes
  constructor(private readonly opts: { pool; conversationId }) {}

  emit(event: CapabilityEvent): void {                 ← SYNC: aptkit's contract
    const { pool, conversationId } = this.opts;
    if (event.type === 'step' && event.role === 'assistant' && event.content) {
      this.pending.push(persistMessage(pool, conversationId, 'assistant', event.content));
    } else if (event.type === 'tool_call_end') {       ← tool name + result
      this.pending.push(persistMessage(pool, conversationId, 'tool', event.toolName,
        { toolResults: event.result }));
    }
       │
       └─ note: never awaited here. emit can't block the loop, so we queue.
  }

  async flush(): Promise<void> { await Promise.all(this.pending); }
       │
       └─ ask-cmd.ts:35 awaits this BEFORE pool.end() — without it, inserts
          race the pool shutdown and rows are silently lost.
}
```

The wiring (`src/cli/ask-cmd.ts:29-35`):

```
const conversationId = await startConversation(pool, cfg.appId);  ← fresh every run
await persistMessage(pool, conversationId, 'user', question);     ← the question
const trace = new SupabaseTraceSink({ pool, conversationId });
const agent = new RagQueryAgent({ model, tools, profile, trace });
const answer = await agent.answer(question);
await trace.flush();                                              ← settle queued writes
       │
       └─ startConversation is NEW each time — no prior conversation is read in.
          That absence is the "capture, not recall" gap.
```

---

## Elaborate

The spec's agent-memory-tiers model (working / episodic / long-term) maps onto
buffr like this: **working** = the loop's `messages` array (built); **long-term
knowledge** = the indexed corpus (built, see `03-agentic-retrieval.md`);
**episodic** = summaries of past runs retrieved by relevance — and episodic is
exactly the tier buffr captures the data for but does not yet retrieve. The
load-bearing problem for episodic memory is the *retrieval* of the right past
run at the right time, which is RAG inside the agent — buffr already has the RAG
machinery, so Phase B is "point the existing retrieval at `agents.messages`,"
not new infrastructure.

Deeper system-design treatment of the sink's write-path mechanics (the
sync-emit/async-flush contract, the conversation/message schema) lives in
`.aipe/study-system-design/03-trajectory-capture.md`. This file owns the
*memory-tier* framing and the honest capture-vs-recall gap.

---

## Interview defense

**Q: Does your agent remember past conversations?**
No — and I'd be precise about that. It *captures* every trajectory to Postgres, but it never reads them back into a later run. Each run starts a fresh conversation. The capture is a fine-tuning corpus and audit log, not episodic memory. Building recall is a read path on top of the existing write path.

```
  capture (built):  run → DB
  recall (planned): DB → next run's context   ← missing arrow
```
Anchor: "I capture trajectories; I don't recall them yet — and I won't claim I do."

**Q: Why persist trajectories you don't use?**
Because capture is cheap and the option it preserves is expensive. If Phase-4 evals show a narrow model-gap failure, I can fine-tune on real trajectories — but only if I captured them from day one. Shipping without capture forecloses that option.
Anchor: "Capture before recall — keep the training option open early."

---

## Validate

1. **Reconstruct:** Draw the sync-emit / async-flush flow. Why can't `emit`
   await? (aptkit's `CapabilityTraceSink.emit` returns `void`,
   `supabase-trace-sink.ts:27`.)
2. **Explain:** What breaks if `ask-cmd.ts` skips `await trace.flush()` before
   `pool.end()`? (`ask-cmd.ts:35-38`.)
3. **Apply:** Where in the code would you add cross-session recall, and what
   existing machinery would you reuse? (Read path over `agents.messages` using
   the retrieval pipeline from `03-agentic-retrieval.md`.)
4. **Defend:** Argue why "capture now, recall later" is the right sequencing for
   a learning/portfolio agent. (`agent-layer-plan.md:17, 118`.)

---

## See also

- `01-bounded-react-loop.md` — the loop whose events the sink records
- `03-agentic-retrieval.md` — the RAG machinery Phase B would reuse for recall
- `audit.md` — Lens 4 (memory & state)
- `.aipe/study-system-design/03-trajectory-capture.md` — the write-path mechanics
- Agent memory (sibling generator): `.aipe/study-ai-engineering/04-agents-and-tool-use/05-agent-memory.md`
