# Trajectory as memory (capture + relevance recall; no in-prompt history yet)

**Industry name(s):** Trajectory capture / agent run logging + retrieval-based
episodic memory · *Industry standard (capture + recall) + Project-specific (the thesis)*

---

## Zoom out, then zoom in

Two things now happen to every exchange. (1) As the run happens, every assistant
turn and every tool call is written to Postgres by the trace sink — the original
capture path, buffr's stated differentiator: keep the whole trajectory so
fine-tuning is *answerable* later. (2) After the run settles, the finished
question-and-answer pair is *embedded* into the same vector store, tagged
`kind=memory`, by aptkit's `createConversationMemory`. That second path is new —
it makes past exchanges **recallable by relevance**.

```
  Zoom out — capture (sink) AND recall (memory engine)

  ┌─ Agent loop (aptkit) ─────────────────────────────────────┐
  │  each turn: trace.emit({ step | tool_call | usage | … })  │
  └───────────────┬───────────────────────────────┬───────────┘
                  │ emit() (sync, queued)          │ after answer
  ┌─ Trajectory sink (buffr) ─▼──────┐  ┌─ Memory engine (aptkit) ─▼────────┐
  │ ★ SupabaseTraceSink ★            │  │ ★ conversationMemory.remember() ★ │ ← we are here
  │   → persistMessage(...)          │  │   embed(Q+A) → store.upsert()     │
  └───────────────┬──────────────────┘  └───────────────┬────────────────────┘
                  │ INSERT                               │ UPSERT (kind=memory)
  ┌─ Storage ─────▼────────────────────────────────────▼──────────────────────┐
  │  agents.messages (audit/training)   ·   chunks (shared vector store)        │
  └─────────────────────────────────────────────────────────────────────────────┘
```

Zoom in — and here's the honest split. Memory IS now recalled, but only one of
*two* kinds of memory. **Relevance recall: yes.** A past exchange embedded into
the shared store surfaces on a later turn — across sessions — when the agent's
`search_knowledge_base` call lands near it semantically. **Sequential in-prompt
history: no.** `RagQueryAgent.answer()` still treats each question independently;
it does not thread the running transcript of the current chat into the prompt.
The Phase A / Phase B split below makes the remaining gap precise.

---

## Structure pass

**Axis: state — who owns the run's record, and is it read back?**

```
  "where does the exchange live, and which way is it recalled?" — traced out

  ┌──────────────────────────────────────────────┐
  │ in-loop: messages array                       │  → owned by the loop,
  │   working state, gone when run ends            │    lives in RAM
  └──────────────────────────────────────────────┘
      ┌──────────────────────────────────────────┐
      │ sink: agents.messages                      │  → durable audit/training
      │   every event row, written-through         │    corpus; NOT read back
      └──────────────────────────────────────────┘
          ┌──────────────────────────────────────┐
          │ memory: chunks (kind=memory)           │  → durable AND recalled
          │   embedded Q+A, shared vector store     │    by similarity, cross-session
          └──────────────────────────────────────┘
```

**The two seams that matter:**

1. **The recall arrow that now EXISTS** — from `chunks (kind=memory)` *back into*
   a later run, but indirectly: memory rows share the documents' store, so they
   surface through the existing `search_knowledge_base` tool, not through a
   dedicated recall call. That shared-store trick is what makes relevance recall
   real without new retrieval infrastructure.
2. **The seam still missing** — the running transcript of *this* conversation is
   never threaded into the next prompt. Relevance recall fills the cross-session
   gap; it does not give the agent turn-by-turn conversational context. Naming
   both honestly is the point of this file.

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
  emit(event):                                         // six event variants now
    if event is step with content:
      pending.push( persistMessage(role=event.role, content) )      // don't await
    else if event is tool_call_start:
      pending.push( persistMessage('tool_call', toolName, {args}) )  // the cause
    else if event is tool_call_end:
      pending.push( persistMessage('tool', toolName, {result,error,durationMs}) )
    else if event is model_usage:
      pending.push( persistMessage('model_usage', '', {model, tokensUsed}) )
    else if event is warning or error:
      pending.push( persistMessage(event.type, event.message) )

  flush():
    await Promise.all(pending)     // settle every queued write
```

What breaks without the flush: `session.ts` close() calls `pool.end()`; without
`await trace.flush()` first, the queued inserts race the pool shutdown and some
trajectory rows silently never land. (The flush now happens per-turn inside
`ask()`, before the session is held open for the next question.)

**Six event types, full-signal capture.** The sink no longer drops anything on
the floor. A `step` becomes a message of that event's role; `tool_call_start`
records the args (the *cause*), `tool_call_end` records result + error +
durationMs, `model_usage` fills the otherwise-orphaned `tokens_used` column, and
`warning`/`error` events are persisted too. Each row carries the event's own
`timestamp` into `created_at`, so replay order matches emit order rather than the
race between concurrent flush inserts. The user's question is persisted
separately, up front, before the agent runs.

```
  Layers-and-hops — six event types to rows

  ┌─ loop ───────┐ step / tool_call_start  ┌─ sink ───────┐ INSERT  ┌─ db ──────┐
  │ runAgentLoop │ tool_call_end           │ SupabaseT... │ ──────► │ messages  │
  │              │ model_usage             │ (queues all  │         │ (full     │
  │              │ warning / error ────────►│  6 variants) │         │  signal)  │
  └──────────────┘                         └──────────────┘         └───────────┘
```

### Move 2.5 — current state vs future state

This concept is built-but-partial, but the *line* has moved. Phase A is no
longer just capture — relevance recall now ships. What's still gated is
sequential in-prompt history.

```
  Phase A (now): capture + relevance recall    Phase B (still gated): in-prompt history

  run ──► trajectory ──► agents.messages        next turn in THIS chat
            │                                      │
            └─► remember(Q+A) ──► chunks           │  no running transcript is
                  (kind=memory, shared store)       │  threaded into the prompt
                       │                            ▼
                later turn: search_knowledge_base  RagQueryAgent.answer() treats
                surfaces the relevant past          each question independently —
                exchange by similarity (X-session)  that's the missing arrow today
```

**What's true now:** each chat session opens ONE conversation
(`session.ts:55`) held across every turn, and after each answer
`memory.remember({ conversationId, question, answer })` embeds the exchange into
the shared store (`session.ts:66`). On a later turn — even a later session — when
the agent issues a `search_knowledge_base` call, memory rows compete with
document chunks for the top-k and the relevant past exchange can surface. So the
DB is no longer write-only from the agent's perspective: it's recalled, *by
similarity*, indirectly through the existing retrieval tool.

**What's still gated and why:** the running transcript of the current chat is not
threaded into the prompt — `RagQueryAgent.answer()` (aptkit) takes one question
and no history. So "what did I just ask you?" only works if the prior exchange
happens to be *retrieved* by relevance, not because the turn sits in context.
That's an aptkit-side change (thread message history through `answer`), not a
buffr wiring change. Until then, relevance recall is the memory the agent has.

**What didn't have to change:** the retrieval infrastructure. Memory rides the
*same* `PgVectorStore` and the *same* `search_knowledge_base` tool the documents
use — `createConversationMemory` only needed an embedder and that store
injected (`session.ts:53`). Memory chunks live with no `documents` row, which the
deliberately-dropped chunk→document FK allows (`context.md:33`). No new index, no
new tool, no new query path.

### Move 3 — the principle

Capture before recall, then recall by relevance before recall by sequence. buffr
first recorded the full trajectory from day one (option preserved), then added
the cheapest possible recall — embed the exchange into a store you already
search, and let the existing tool surface it. The honest discipline is naming
*which* recall you have: relevance recall (a past exchange resurfaces when it's
semantically near the current question) is not the same as conversational
threading (the last three turns sit in the prompt). buffr has the first and not
the second, and says so.

---

## Primary diagram

```
  Trajectory capture + relevance recall in buffr — full recap

  ┌─ session.ts (ChatSession.ask, held across turns) ─────────┐
  │ conversationId = startConversation(pool, appId)  ← once    │
  │ memory = createConversationMemory({ embedder, store })     │
  │ persistMessage('user', question)        ← the question     │
  │ answer = agent.answer(question)  ─────────┐ emits during   │
  │ await trace.flush()                       │ the run        │
  │ memory.remember({ conversationId, Q, A }) │ ← embed exchange│
  └──────────────────────┬──────────────────┼─────────────────┘
                CAPTURE  ▼          RECALL    ▼
  ┌─ SupabaseTraceSink ─────────┐  ┌─ conversationMemory ───────┐
  │ emit(6 event variants)      │  │ remember: embed(Q+A) →      │
  │   → pending.push(insert)    │  │   store.upsert(kind=memory) │
  │ flush() → Promise.all       │  │ (recall is implicit: shared │
  └──────────────┬──────────────┘  │  store → search tool finds) │
                 ▼                  └──────────────┬─────────────┘
  ┌─ Postgres (agents schema) ────────────────────▼────────────┐
  │ conversations(id, app_id, agent_name)                      │
  │ messages(...)  ← audit + training corpus, NOT read back     │
  │ chunks(kind=memory)  ← embedded Q+A, RECALLED by similarity │
  │   via search_knowledge_base, across sessions                │
  └─────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

### Use cases

Reached on every turn of `npm run chat`. The session
(`src/session.ts`) opens ONE conversation, then each `ask()` records the user
question, runs the agent, flushes the trace, and `remember()`s the finished
exchange. Two purposes now: (1) `agents.messages` is the audit log + training
corpus for the Phase-4 fine-tuning decision; (2) the embedded exchange in
`chunks` is *episodic memory* — it gives the agent relevance-based recall of past
chats, across sessions, through the same retrieval tool it already uses. What it
still does NOT do: thread the current conversation's transcript into the next
prompt.

### Code, side by side

The sink — six event variants, full-signal (`src/supabase-trace-sink.ts:49-85`):

```
export class SupabaseTraceSink implements CapabilityTraceSink {
  private readonly pending: Promise<void>[] = [];      ← queued writes
  emit(event: CapabilityEvent): void {                 ← SYNC: aptkit's contract
    const at = event.timestamp;                         ← event order, not race order
    switch (event.type) {
      case 'step':            persist(event.role, event.content)            ← assistant/user turn
      case 'tool_call_start': persist('tool_call', toolName, {args})        ← the cause
      case 'tool_call_end':   persist('tool', toolName, {result,error,ms})  ← the effect
      case 'model_usage':     persist('model_usage', '', {model,tokensUsed})← fills tokens_used
      case 'warning'|'error': persist(event.type, event.message)            ← nothing dropped
    }
       │
       └─ never awaited here. emit can't block the loop, so each write is queued.
  }
  async flush(): Promise<void> { await Promise.all(this.pending); }
       │
       └─ awaited per turn before the next ask(); without it inserts could race
          a later pool.end() and rows would be silently lost.
}
```

The wiring — capture AND recall, one conversation held across turns
(`src/session.ts:53-70`):

```
const memory = createConversationMemory({ embedder, store }); ← aptkit engine, buffr's store
const conversationId = await startConversation(pool, cfg.appId); ← ONCE, not per turn
const trace = new SupabaseTraceSink({ pool, conversationId });
const agent = new RagQueryAgent({ model, tools, profile, trace });

async ask(question) {
  await persistMessage(pool, conversationId, 'user', question); ← the question
  const answer = await agent.answer(question);                  ← no history threaded in
  await trace.flush();                                          ← settle queued writes
  try { await memory.remember({ conversationId, question, answer }); } ← embed the exchange
  catch { /* best-effort: a memory write must not lose the answer */ }
  return answer;
}
       │
       └─ startConversation runs ONCE (session-scoped), and remember() embeds each
          exchange into the SHARED store — so a later search_knowledge_base call
          surfaces it by similarity. That IS the recall path; it just isn't a
          dedicated recall() call (memory rides the documents' store and tool).
```

The recall is *implicit*: buffr calls `memory.remember()` but never
`memory.recall()`. Because memory rows live in the same `PgVectorStore` as
documents (tagged `kind=memory`), they compete in the agent's normal
`search_knowledge_base` top-k. The engine's own `recall()` over-fetches and
filters by `kind` — buffr doesn't need it here because the shared store already
mixes memory into retrieval (`conversation-memory.js:44-61`).

---

## Elaborate

The spec's agent-memory-tiers model (working / episodic / long-term) maps onto
buffr like this: **working** = the loop's `messages` array (built);
**long-term knowledge** = the indexed corpus (built, see `03-agentic-retrieval.md`);
**episodic** = summaries of past exchanges retrieved by relevance — and episodic
is now *built*, via `createConversationMemory` embedding each Q+A into the shared
store. The load-bearing problem for episodic memory was always the *retrieval* of
the right past exchange at the right time, which is RAG inside the agent — buffr
already had the RAG machinery, so this was "embed the exchange into the store you
already search," not new infrastructure. What remains is the *working-context*
half of memory: threading the running transcript of the current chat into the
prompt, which is an aptkit-side change to `RagQueryAgent.answer()`.

Deeper system-design treatment of the sink's write-path mechanics (the
sync-emit/async-flush contract, the conversation/message schema) lives in
`.aipe/study-system-design/03-trajectory-capture.md`. This file owns the
*memory-tier* framing and the honest relevance-recall-yes / in-prompt-history-no
distinction.

---

## Interview defense

**Q: Does your agent remember past conversations?**
Partly, and I'd be precise about which part. It has *relevance recall*: after every exchange I embed the question-and-answer pair into the same vector store the documents live in, tagged `kind=memory`, so on a later turn — even a later session — the agent's normal `search_knowledge_base` call can surface the relevant past exchange by similarity. What it does NOT have is *conversational threading*: `RagQueryAgent.answer()` takes one question and no transcript, so "what did I just ask?" only works if that prior turn happens to be retrieved by relevance, not because it sits in context.

```
  relevance recall (built):  exchange → embed → shared store → search surfaces it
  in-prompt history (gated):  this chat's transcript → prompt   ← still missing
```
Anchor: "Relevance recall yes, conversational threading no — and I won't blur the two."

**Q: Why did adding memory take almost no new infrastructure?**
Because I made memory ride the retrieval I already had. `createConversationMemory` only needed an embedder and a vector store; I injected buffr's `PgVectorStore`. Memory chunks share the documents' store, so they surface through the existing `search_knowledge_base` tool — no new index, no new tool, no recall call. The dropped chunk→document FK is what lets a memory row exist with no documents row behind it.
Anchor: "Memory rides the documents' store and tool — recall for free."

---

## Validate

1. **Reconstruct:** Draw the sync-emit / async-flush flow AND the
   remember-after-answer flow. Why can't `emit` await? (aptkit's
   `CapabilityTraceSink.emit` returns `void`, `supabase-trace-sink.ts:53`.)
2. **Explain:** What breaks if `session.ts` skips `await trace.flush()` before
   the next turn or before `pool.end()`? (`session.ts:63, 74`.)
3. **Apply:** The agent recalls past exchanges by relevance but not the running
   transcript. Where would you add conversational threading, and why is it an
   aptkit change not a buffr one? (`RagQueryAgent.answer()` takes no history;
   `session.ts:62`.)
4. **Defend:** Argue why relevance recall via the shared store is the right first
   memory to ship, ahead of in-prompt history. (`session.ts:53, 66`;
   `conversation-memory.js:18-43`.)

---

## See also

- `01-bounded-react-loop.md` — the loop whose events the sink records
- `03-agentic-retrieval.md` — the `search_knowledge_base` tool that surfaces memory rows
- `audit.md` — Lens 4 (memory & state)
- `.aipe/study-system-design/03-trajectory-capture.md` — the write-path mechanics
- Agent memory (sibling generator): `.aipe/study-ai-engineering/04-agents-and-tool-use/05-agent-memory.md`

---

Updated: 2026-06-24 — Reframed from "write-only, never recalled" to capture +
relevance recall via @aptkit/memory (`createConversationMemory`, shared store):
memory IS now recalled by similarity across sessions through the existing
`search_knowledge_base` tool; the honest gap is now sequential in-prompt history
(`RagQueryAgent.answer()` still treats each question independently). Purged
`ask-cmd.ts` refs → `session.ts`; sink now full-signal (6 event variants).
