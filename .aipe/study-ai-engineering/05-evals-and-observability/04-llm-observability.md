# LLM observability

### Traces, spans, and replay — the trace sink that records every event the agent emits into a local table

Evals tell you if the system is good *in aggregate*. Observability tells you what *one specific run* actually did — every model call, every tool call, the args that caused each, the duration and tokens. This is the half of the folder that buffr does well: the **trace sink** (`SupabaseTraceSink`) captures all six event types the agent emits and writes them into a local Postgres table. It's the "an `ai_trace` table for solo work" pattern — no SaaS, no dashboard, just a queryable record on your laptop.

```
THE OBSERVABILITY STACK
┌──────────────────────────────────────────────────────────────┐
│  Agent run   RagQueryAgent emits CapabilityEvents             │
├──────────────────────────────────────────────────────────────┤
│  ★ TRACE SINK   SupabaseTraceSink.emit()  (THIS FILE)         │
│      6 events → agents.messages  (traces + spans)             │
├──────────────────────────────────────────────────────────────┤
│  Store       Postgres agents.messages (local, queryable)     │
├──────────────────────────────────────────────────────────────┤
│  Replay      aptkit replay-runner.ts  ── ✗ UNWIRED in buffr   │
│  Dashboard   ── ✗ none ·  Cost ($)  ── ✗ none                 │
└──────────────────────────────────────────────────────────────┘
```

Lead with the sink because it's the load-bearing, *implemented* piece. The replay runner and dashboard are named gaps below it.

## Structure pass

Two terms structure observability: a **trace** is the whole story of one request (the conversation row), and a **span** is one timed unit of work inside it (a tool call, with `durationMs`). The axis that organizes the events is **cause vs. effect**: `tool_call_start` records the *cause* (the args that triggered the call), `tool_call_end` records the *effect* (result, error, duration). buffr persists both, so the trajectory is replayable in order.

```
ONE AXIS — cause ──► effect, per event type        persisted as
  step             assistant text (a reasoning beat)   role='assistant'
  tool_call_start  CAUSE: toolName + args              role='tool_call'   tool_calls
  tool_call_end    EFFECT: result/error + durationMs   role='tool'        tool_results  ← SPAN
  model_usage      provider/model + tokens             role='model_usage' tokens_used
  warning / error  the failure beats                   role=type          content
        ▲
   TRACE = one conversation row gathering all of the above, ordered by created_at
```

The seam: aptkit's contract makes `emit()` **synchronous** (it returns `void`, no `await`), but the writes are to Postgres, which is async. buffr resolves this by *queuing* the insert promises and awaiting them all in `flush()` after the run. The ordering is preserved not by insert timing (those race) but by writing the **event timestamp** into `created_at` — so replay order matches emit order deterministically.

## How it works

### Move 1 — mental model: the sink is a sync fan-out into a queue, drained once

The agent emits events one at a time, synchronously, mid-run — it can't wait for a database. The sink's job is to translate each event into a queued insert *without blocking*, then drain the queue once at the end. Think of it as a buffered writer: `emit()` appends, `flush()` commits.

```
THE SINK PATTERN (sync emit, deferred drain)
   agent ──emit(e)──► switch(e.type) ──► persistMessage(...)  ──► pending[]  (queued)
   agent ──emit(e)──► ...                                          ▲ no await here
   agent ──emit(e)──► ...
                                        run ends
   session ──flush()──► Promise.all(pending)  ──► all rows committed, ordered by created_at
```

Bridging from what you know: this is the same shape as a logging library with an async transport — `log()` is fire-and-forget into a buffer, and you `flush()` on shutdown. The twist is the *ordering guarantee*: because concurrent inserts race, buffr stamps `created_at` from the event itself so the *read-back* order is deterministic regardless of which insert lands first.

### Move 2 — the SupabaseTraceSink, in code

Every event type is captured. The previous version dropped tool args, durations, and tokens on the floor; this one persists the full trajectory.

**emit() is sync — it queues, never awaits.** The aptkit `CapabilityTraceSink` contract returns `void`. So `emit` pushes a promise and returns immediately; nothing blocks the agent.

```
src/supabase-trace-sink.ts:53  emit(event): void          ← sync, returns void
              :87  private push(p) { this.pending.push(p) }  ← queue, no await
              :91  async flush() { await Promise.all(this.pending) }  ← drain once
```

**tool_call_start persists the CAUSE — args.** This is the line that turns the table from "what happened" into "*why* it happened": the args that triggered the tool are stored in `tool_calls`.

```
src/supabase-trace-sink.ts:62  case 'tool_call_start':
              :63  persistMessage(..., 'tool_call', event.toolName, {
                     toolCalls: { toolName, args: event.args },  ← THE CAUSE
                     createdAt: at })
```

**tool_call_end persists the EFFECT — result, error, and the span duration.** `durationMs` is what makes this a *span*, not just a log line: you get the timed cost of every tool call.

```
src/supabase-trace-sink.ts:67  case 'tool_call_end':
              :68  persistMessage(..., 'tool', event.toolName, {
                     toolResults: { result, error, durationMs },  ← EFFECT + SPAN
                     createdAt: at })
```

**model_usage fills the tokens column.** Provider and model are flattened to `provider/model`; input + output tokens sum into `tokens_used` — the column that was otherwise orphaned.

```
src/supabase-trace-sink.ts:73  case 'model_usage':
              :74  persistMessage(..., 'model_usage', '', {
                     model: `${event.provider}/${event.model}`,
                     tokensUsed: (inputTokens ?? 0) + (outputTokens ?? 0),  ← fills tokens_used
                     createdAt: at })
```

**created_at carries the event timestamp for deterministic replay order.** Every branch passes `createdAt: at` (the `event.timestamp`). `persistMessage` coalesces it into the column, so reading the trace back in `created_at` order reproduces emit order — not the race between flush inserts.

```
src/supabase-trace-sink.ts:55  const at = event.timestamp     ← captured once
   persistMessage ... coalesce($8::timestamptz, now())         ← event time wins
   ⇒ SELECT ... ORDER BY created_at  =  exact emit order        ← deterministic replay
```

**Where it's wired.** `src/session.ts:55`–`56` opens a conversation row and constructs the sink; `:63` flushes after each turn. One conversation = one trace; the sink fans every event into its messages.

```
src/session.ts:55  conversationId = startConversation(pool, cfg.appId)   ← the trace
              :56  trace = new SupabaseTraceSink({ pool, conversationId })
              :63  await trace.flush()                                    ← drain per turn
```

### Move 2.5 — current vs. future: recorded, but not replayed or visualized

buffr *records* a complete, ordered, replay-ready trajectory. It does nothing further with it yet.

```
                       buffr today          gap
 capture (6 events)     ████ complete        —
 spans (durationMs)     ████ captured         —
 tokens                 ████ captured         —
 REPLAY a trajectory    ░░░░                  replay-runner.ts exists in aptkit, UNWIRED
 dashboard / charts     ░░░░                  none
 cost ($)               ░░░░                  tokens captured, never priced
```

- **Replay (Case B).** aptkit ships `replay-runner.ts` — it lists artifact JSON files, validates each against a capability-replay shape, and reports pass/fail. buffr captures everything a replay needs but never calls it: there's no step that turns an `agents.messages` trace into a replay artifact and re-asserts it.
- **Dashboard (Case B).** No UI. The data is a Postgres table; you read it with SQL or not at all.
- **Cost (Case B).** `tokens_used` is populated, but never multiplied by a price. For a local Ollama model the dollar cost is ~zero, but the *token* cost (latency proxy) is right there and unsummarized.

### Move 3 — the principle

**Capture the cause, the effect, and the clock — or the trace can't answer "why."** A log that records only outputs tells you *what* the agent said; a trace that records args (cause), results+errors (effect), and durations+timestamps (the clock) tells you *why* it said it and *what it cost*. buffr's sink captures all three, which is exactly what makes the unwired replay and cost-summary *possible* — the data is already on disk; the gap is only the reader.

## Primary diagram

The full path from agent event to a replayable, ordered local trace — and the readers buffr hasn't built.

```
                    LLM OBSERVABILITY (buffr)
   RagQueryAgent ─emit(event)─► SupabaseTraceSink  [src/supabase-trace-sink.ts:53]
       (sync)                        │ switch(type)
                                     ├ tool_call_start → tool_calls (CAUSE: args)
                                     ├ tool_call_end   → tool_results (EFFECT + durationMs ← SPAN)
                                     ├ model_usage     → tokens_used
                                     ├ step            → assistant text
                                     └ warning/error   → content
                                     │  push → pending[]   (no await)
                       session.ts:63 │  flush() → Promise.all
                                     ▼
            Postgres agents.messages  (created_at = event.timestamp ⇒ ordered TRACE)
                                     │
         ✗ replay-runner.ts (aptkit, UNWIRED)   ✗ dashboard   ✗ cost($)
```

## Elaborate

Why the sync-emit/deferred-flush split is the correct shape and not a workaround: the agent loop is latency-sensitive and runs on the user's request path; making `emit()` `await` a Postgres insert would serialize the agent behind the database, adding a round-trip per event to every response. Decoupling capture (cheap, sync, in-memory queue) from durability (one batched `Promise.all` at the seam) keeps the hot path fast and pays the I/O cost once, off the critical loop. The cost of the split is that a crash mid-run loses the unflushed queue — acceptable for solo observability, not for an audit log, and worth naming as the tradeoff.

Why `created_at = event.timestamp` is load-bearing for replay, not a nicety: replay means re-running the recorded sequence *in order*. If you ordered by insert time, concurrent flushes would scramble the sequence — tool_call_end could land before its own tool_call_start. Stamping the column from the event's own timestamp makes `ORDER BY created_at` reproduce the exact emit order deterministically, which is the precondition for the unwired `replay-runner` to ever do its job. The capture was designed *for* a replay that isn't wired yet — which is exactly why [B3.11] is a small wiring exercise, not a rebuild.

## Project exercises

### Add a tokens/latency summary query over captured traces

- **Exercise ID:** [B3.5] (cite [C3.5], Phase 3) — Case A: the data is captured; this is the next step — read it.
- **What to build:** A small CLI/SQL report over `agents.messages` that, per conversation, sums `tokens_used` and sums tool-call `durationMs` (from `tool_results`), and prints a per-run and mean latency/token summary.
- **Why it earns its place:** buffr captures spans and tokens but never surfaces them — the table is write-only in practice. This turns the trace into the cost/latency dashboard buffr lacks, with zero new capture work.
- **Files to touch:** new `src/cli/trace-summary.ts` (sibling to `src/cli/eval-cmd.ts`) reading `agents.messages` via `src/db.ts`; schema in `sql/001_agents_schema.sql`.
- **Done when:** A command prints per-conversation total tokens and total tool latency, plus the mean across recent runs, sourced entirely from captured traces.
- **Estimated effort:** 0.5–1 day.

### Wire the replay runner against recorded trajectories

- **Exercise ID:** [B3.11] (cite [C3.11], Phase 3) — Case B: aptkit's `replay-runner.ts` exists but buffr never calls it. This exercise is primary.
- **What to build:** A step that exports an `agents.messages` trace (ordered by `created_at`) into a replay artifact JSON, then runs aptkit's `evaluateReplayArtifactFiles` to validate/re-assert it — closing the capture→replay loop the sink was designed for.
- **Why it earns its place:** buffr records a complete, ordered, replay-ready trajectory and then does nothing with it. Wiring the runner turns "we have traces" into "we can re-run and re-check a past trajectory" — regression-proofing the agent's behavior.
- **Files to touch:** new exporter reading `agents.messages` (`src/supabase-trace-sink.ts` schema); import `evaluateReplayArtifactFiles` from aptkit; a `replay/` artifact dir; a CLI in `src/cli/`.
- **Done when:** A recorded conversation exports to an artifact, the replay runner validates it, and a deliberately corrupted artifact is reported as failed.
- **Estimated effort:** 2–3 days.

## Interview defense

**Q: "`emit()` is synchronous but you're writing to Postgres. How does that not block the agent or lose ordering?"**

Two moves. For *blocking*: `emit()` honors aptkit's sync `void` contract by pushing the insert promise into a `pending[]` queue and returning immediately — nothing on the agent's hot path awaits the database. The writes drain once at the seam via `flush()` → `Promise.all`, so I/O is paid in one batch off the critical loop. For *ordering*: the batched inserts race, so I don't trust insert time — I stamp `created_at` from `event.timestamp`, so reading the trace back `ORDER BY created_at` reproduces exact emit order. The tradeoff is that a crash before `flush()` loses the unflushed queue, which is fine for solo observability.

```
   emit() ─► queue (sync, no await)        ⇒ agent never blocks
   flush() ─► Promise.all (batched I/O)    ⇒ paid once at the seam
   created_at = event.timestamp            ⇒ deterministic replay order (not insert race)
```

*Anchor: capture is sync and cheap; durability is deferred and batched; order comes from the event clock, not the insert clock.*

**Q: "You capture traces — so what can't you do yet?"**

I can't *replay* or *visualize* them. The capture is complete: all six events, tool args (cause), results/errors and `durationMs` (effect + spans), tokens — ordered for deterministic replay. But the readers aren't wired: aptkit's `replay-runner` exists and buffr never calls it, there's no dashboard, and `tokens_used` is captured but never summarized or priced. The data was deliberately captured replay-ready, so closing these is wiring ([B3.11], [B3.5]), not a rebuild.

```
   capture   ████ complete (6 events, spans, tokens, ordered)
   replay    ░░░░ replay-runner exists in aptkit, unwired
   summarize ░░░░ tokens/latency captured, never read
```

*Anchor: buffr's trace is a fully-stocked warehouse with no one yet sent in to read the shelves.*

## See also

- **`03-llm-as-judge-bias.md`** — the judged answers and their chunks are recorded here; replay + judge together regression-proof behavior.
- **`02-eval-methods.md`** — aggregate scores vs. per-run traces: two complementary views of the same system.
- **`../06-production-serving/`** — captured tokens/latency are the raw input to cost tracking and rate limiting.
- **`study-debugging-observability/`** — the general trace/span/replay treatment this file specializes to the agent.
- **`../04-agents-and-tool-use/`** — the agent loop whose events the sink captures.
