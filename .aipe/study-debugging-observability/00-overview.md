# Overview — Debugging & Observability in buffr-laptop

The verdict first: this repo has **one** real observability mechanism, and it's
good. `SupabaseTraceSink.emit()` (`src/supabase-trace-sink.ts:53`) persists every
one of the six `CapabilityEvent` types the agent loop emits, into
`agents.messages`. That makes the messages table a full, replayable trajectory of
what the agent did — the args it called a tool with (the *cause*), the result and
error and `durationMs` it got back, the tokens it spent, and any warning/error
along the way. Most repos at this stage drop everything except the final answer.
This one doesn't.

Everything else is thin, and that's fine for a single-device, single-user laptop
brain. There's no Prometheus, no OpenTelemetry, no Sentry, no log levels, no
health check. Those aren't bugs — they're `not yet exercised`, and the audit says
when each one starts to matter.

## The observability map — one diagram

The whole evidence surface of the repo, by boundary. The thick box is the only
place that produces durable, queryable evidence.

```
  buffr-laptop — where behavior becomes evidence

  ┌─ UI layer (Ink TUI) ─────────────────────────────────────────┐
  │  chat.tsx  →  catch(err) renders "error: <msg>" as a turn     │
  │              (src/cli/chat.tsx:30)  — ephemeral, screen only  │
  └───────────────────────────────┬──────────────────────────────┘
                                   │  session.ask(question)
  ┌─ Session layer ───────────────▼──────────────────────────────┐
  │  session.ts  →  agent.answer()  →  trace.flush()              │
  │  memory.remember() in try/catch, swallowed (session.ts:66)   │
  └───────────────────────────────┬──────────────────────────────┘
                                   │  6 CapabilityEvent types
  ┌─ Trace sink (THE evidence store) ════════════════════════════┐
  │ ║ SupabaseTraceSink.emit()  (src/supabase-trace-sink.ts:53) ║ │ ★ here
  │ ║ step·tool_call_start·tool_call_end·model_usage·warn·error ║ │
  └───────────────────────────────┬──────────────────────────────┘
                                   │  insert ... created_at = event.timestamp
  ┌─ Storage layer (Postgres) ────▼──────────────────────────────┐
  │  agents.messages  — the trajectory, replayable in emit order │
  │  agents.conversations  — one row per chat session            │
  └──────────────────────────────────────────────────────────────┘

  Off to the side, no shared store:
  ┌─ One-shot CLIs ──────────────────────────────────────────────┐
  │  index-cmd.ts  → stdout "indexed X"   (src/cli/index-cmd.ts:25)│
  │  eval-cmd.ts   → stdout P@1 / R@3     (src/cli/eval-cmd.ts:31) │
  └──────────────────────────────────────────────────────────────┘
```

## Ranked findings

1. **Full-signal trajectory capture is the headline.** All six event types
   persisted, `tokens_used` and `durationMs` filled, not just the answer. If you
   want to know *why* an answer came out wrong, the tool args and results are
   right there in `messages`, ordered. → `01-full-signal-trajectory-capture.md`.

2. **Deterministic replay order via client timestamps.** `created_at` is
   `coalesce($8::timestamptz, now())` where `$8` is `event.timestamp`
   (`src/supabase-trace-sink.ts:30`, `:54`). Replay order = emit order, not the
   race between concurrent flush inserts. → `02-client-timestamp-ordering.md`.

3. **The fallback answer is invisible to the trace.** When the model returns
   empty text, the loop's `step` event is gated behind `if (text)` and never
   fires; `RagQueryAgent.answer()` then substitutes `FALLBACK_ANSWER`. The user
   sees "I couldn't find anything…" but the trajectory has no row recording that
   answer. The one place evidence is missing. → audit lens 6,
   `01-full-signal-trajectory-capture.md` Move 2.5.

4. **stdout is the only log.** index/eval CLIs and Ink all write plain lines —
   no level, no structure, no conversation-id correlation. Fine at this scale,
   first thing to outgrow. → `03-stdout-as-only-log.md`.

5. **Eval numbers are the only numeric quality signal**, and they're an offline
   batch over a labeled set — not a live SLI. → `04-eval-numbers-as-quality-signal.md`.

## Not yet exercised

Honest blanks. Each becomes relevant at a named trigger:

- **Metrics / Prometheus / SLOs** — no counters, gauges, or aggregation. Becomes
  relevant when more than one user/device shares the store and you need
  rates-over-time instead of per-run rows.
- **OpenTelemetry / distributed tracing** — the trace never leaves one process
  and one DB. Relevant once aptkit's loop runs behind a network boundary
  (Edge Functions, a service) and a request crosses processes.
- **Log levels / structured logs** — `process.stdout.write` only. Relevant when
  output is collected by something that filters or queries it.
- **Sentry / error tracking** — errors go to a `messages` row (sink) or the
  screen (Ink) and stop there; nothing aggregates or alerts. Relevant when a
  failure you didn't watch happen needs to page someone.
- **Health checks / liveness** — none. Relevant when something supervises the
  process instead of a human running `npm run chat`.

## Where to read next

`audit.md` walks all eight lenses with `file:line` grounding. The four pattern
files go deep on the mechanisms above. Neighbors in `README.md`.
