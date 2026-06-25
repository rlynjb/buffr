# Sync interface, async work — `SupabaseTraceSink.emit` / `flush`

> Updated: 2026-06-24 — emit now switches on all 6 CapabilityEvent variants
> (step · tool_call_start · tool_call_end · model_usage · warning · error), not
> just assistant steps + tool results. Choreography moved from the deleted
> `ask-cmd.ts` into `src/session.ts` (`createChatSession`), which holds the sink
> across every turn of a long-lived chat instead of building one per one-shot
> call. The sync-emit / async-flush kernel is unchanged.

**Subtitle:** Fire-and-collect / deferred-await over a synchronous callback —
*Language-agnostic*. aptkit's `emit()` is synchronous; the DB write is not, so the
sink queues promises and drains them once with `flush()`.

---

## Zoom out, then zoom in

aptkit's agent loop wants to *tell* you what happened as it happens — "assistant
said X," "tool Y returned Z" — and it tells you through a synchronous `emit()`
call it expects to return instantly. But persisting each event is a database round
trip, which is `async`. This file is the box that bridges that mismatch without
slowing the agent down.

```
  Zoom out — where the trace sink sits

  ┌─ aptkit RagQueryAgent (the loop) ────────────────────────────┐
  │  step ─► emit(event) ─► step ─► emit(event) ─► ... ─► done    │
  │            │  SYNC: must return now, can't await              │
  └────────────┼─────────────────────────────────────────────────┘
               │  CapabilityTraceSink contract
  ┌─ buffr ────▼─────────────────────────────────────────────────┐
  │  ★ SupabaseTraceSink ★   emit() queues · flush() drains       │ ← we are here
  └────────────┬─────────────────────────────────────────────────┘
               │  async INSERT (per event)
  ┌─ Storage ──▼─────────────────────────────────────────────────┐
  │  agents.messages   (role · content · tool_results)            │
  └──────────────────────────────────────────────────────────────┘
```

**Zoom in.** The pattern is *fire-and-collect*: `emit` is called synchronously and
cannot `await`, so instead of awaiting the DB write it *starts* the write and
pushes the resulting promise into a `pending[]` array — then returns immediately.
After the agent finishes, the shell calls `flush()` once, which `Promise.all`s the
whole queue. The contract stays synchronous; the work stays asynchronous; nothing
blocks the loop.

---

## Structure pass — layers · axis · seams

Two layers: aptkit's agent loop and buffr's sink. The axis that exposes the design
is **timing guarantees** — sync vs async, and when the work is actually done.

```
  Axis traced = "when is the write guaranteed done?"

  ┌─ aptkit loop ──┐  seam: emit()   ┌─ SupabaseTraceSink ─┐
  │  calls emit,   │ ═══════╪═══════► │  emit: NOT done —   │
  │  expects       │  (timing flips) │  queued as promise  │
  │  instant return│                 │  flush: NOW done     │
  └────────────────┘                 └──────────────────────┘
       ▲                                       ▲
       └─ "tell me synchronously" ── "I'll persist eventually" ─┘
                  the seam absorbs the sync/async impedance
```

- **The seam: `emit()`.** Above it the agent assumes a void, instant call. Below
  it the call kicks off an `async` write and returns before it completes. The
  *timing guarantee* flips across this boundary — that's what makes it
  load-bearing. The agent thinks the event is "handled"; really it's "in flight."
- **The second seam: `flush()`.** This is where the deferred guarantee gets
  collected. Between `emit` and `flush`, the writes are racing in the background;
  after `flush` resolves, they're all durable. The shell *must* call it — that's
  the contract the sink hands back upward.
- **Why two methods, not one:** aptkit can't `await emit` (it's sync), so the
  "are we done?" question can't be answered inside `emit`. It's deferred to a
  method the shell *can* await. Splitting fire from collect is the whole pattern.

---

## How it works

### Move 1 — the mental model

You've fired off three `fetch()` calls without awaiting them, collected the
promises in an array, then `await Promise.all(promises)` at the end to wait for all
three? That's exactly this. `emit` is the un-awaited `fetch`; `pending[]` is the
array; `flush` is the `Promise.all`. The strategy: **defer the await** — start the
async work inside a sync function, hold the promise, await the batch later.

```
  Fire-and-collect — the kernel

   emit(e1) ─► pending.push( write(e1) )   ┐ writes race
   emit(e2) ─► pending.push( write(e2) )   │ in the
   emit(e3) ─► pending.push( write(e3) )   ┘ background
        ... agent loop finishes ...
   flush()  ─► await Promise.all(pending)  ◄─ one barrier, all done
```

### Move 2 — the load-bearing skeleton

This concept has an irreducible kernel — three parts, each of which breaks
something specific if removed.

**Part 1 — the queue (`pending: Promise<void>[]`).** The array that holds the
in-flight writes. Remove it and `emit` has nowhere to put the promise; the write
either has to be awaited (impossible — `emit` is sync) or dropped (you lose the
trace). The queue is what lets a sync function defer async work.

```
  pending[] — the hand-off buffer

   emit (sync, can't await) ──push──► [ p1, p2, p3 ] ──Promise.all──► flush
                                       the queue              (the only awaiter)
```

**Part 2 — the un-awaited write inside `emit`.** `emit` calls `persistMessage(...)`
which returns a `Promise`, and pushes it (via the private `push` helper) *without
awaiting*. This is the move that keeps the agent loop fast: the DB round trip
happens off to the side while the loop proceeds to the next step. Remove the
"don't await" and `emit` would need to be `async` — which violates aptkit's
synchronous contract and stalls the loop on every event.

**All six event variants are persisted now, not two.** `emit` is a `switch` over
the full `CapabilityEvent` union (`src/supabase-trace-sink.ts:56-84`): `step`
(assistant/user content), `tool_call_start` (the cause — tool name + args),
`tool_call_end` (result + error + `durationMs`), `model_usage` (token counts into
the once-orphaned `tokens_used` column), and `warning`/`error`. Each pushes one
`persistMessage` promise carrying `event.timestamp` into `createdAt`, so replay
order matches emit order rather than the race between concurrent flush inserts
(`src/supabase-trace-sink.ts:55,59`). The earlier guide only saw `step` +
`tool_call_end`; the sink now captures a complete, replayable trajectory. The
kernel — queue, un-awaited write, single drain — is identical; only the *fan-out*
of event types it handles grew.

**Part 3 — the single drain (`flush`).** `await Promise.all(this.pending)`. This is
the barrier that turns "eventually durable" into "now durable." Remove it and the
shell calls `pool.end()` while writes are still racing — the connections close
mid-INSERT and you silently lose the tail of the trajectory. `flush` is the part
people forget, and it's the one that makes the whole pattern correct.

```
  flush — the barrier (what breaks without it)

   without flush:  agent done ─► pool.end() ─► ✗ writes killed in flight
   with flush:     agent done ─► flush() ─► all writes land ─► pool.end() ✓
```

**Skeleton vs hardening.** The kernel is queue + un-awaited-write + single-drain.
What buffr does *not* have yet (and these are the hardening layers): no per-write
error handling (a failed `persistMessage` rejects the whole `Promise.all` and the
other writes' status is undefined), no backpressure (an infinite agent loop grows
`pending[]` unbounded), no retry. For a single-device CLI tracing a bounded
conversation, the bare kernel is the right amount — naming what's *missing* is the
lesson, not a demand to add it.

### Move 3 — the principle

When you're handed a synchronous interface but the work behind it is asynchronous,
you don't get to change the interface — you absorb the impedance. **Defer the
await: start the work in the sync call, hold the handle, collect at a barrier the
caller can await.** The synchronous contract is preserved on the surface; the
asynchronous reality is preserved underneath. The cost you accept is a window where
the data is in-flight-but-not-durable, and a `flush` the caller must not forget.

---

## Primary diagram

The full lifecycle in one frame.

```
  SupabaseTraceSink — sync emit, async work, single drain

  ┌─ aptkit RagQueryAgent ───────────────────────────────────────┐
  │  answer() { ... emit(step) ... emit(tool_call_end) ... }      │
  └──────────────────────┬───────────────────────────────────────┘
            emit (sync)   │
  ┌──────────────────────▼───────────────────────────────────────┐
  │ SupabaseTraceSink   (src/supabase-trace-sink.ts:49-94)        │
  │  emit(e): switch over ALL 6 variants:                         │
  │    step · tool_call_start · tool_call_end · model_usage ·     │
  │    warning · error  →  pending.push(persistMessage(..))       │
  │  pending: [ Promise, Promise, ... ]   (racing in background)  │
  │  flush(): await Promise.all(pending)   ◄── the barrier        │
  └──────────────────────┬───────────────────────────────────────┘
            async INSERT  │   (session: ask() flushes per turn; close() ends pool)
  ┌──────────────────────▼───────────────────────────────────────┐
  │ Postgres: agents.messages  (conversation_id, role, content)   │
  └────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.** Reached for in exactly one flow, now owned by `src/session.ts`
(the deleted `ask-cmd.ts` used to hold it). `createChatSession` builds the sink
*once* with a conversation id, hands it to `RagQueryAgent`, and reuses it across
every turn (`src/session.ts:55-57`). Inside each `ask()`, the agent emits during
`answer()`, then `await trace.flush()` drains the queue
(`src/session.ts:62-63`). The pool is closed separately in `close()`
(`src/session.ts:72-74`) — called by the Ink UI on `/exit`
(`src/cli/chat.tsx:18-20`). The ordering still matters: every turn must `flush`
before the session is closed, or the trajectory's tail dies in a closing pool.

**Code side by side.**

```
  src/supabase-trace-sink.ts  (emit, lines 53-85) — fire

  emit(event: CapabilityEvent): void {           ← SYNC return type: can't await
    const { pool, conversationId } = this.opts;
    const at = event.timestamp;                   ← carried into created_at so
    switch (event.type) {                            replay order = emit order
      case 'step':
        if (event.content)
          this.push(persistMessage(pool, conversationId,
            event.role, event.content, { createdAt: at }));   ← push, DON'T await
        return;
      case 'tool_call_start':                     ← the CAUSE: tool name + args
        this.push(persistMessage(pool, conversationId, 'tool_call',
          event.toolName, { toolCalls: { ... }, createdAt: at })); return;
      case 'tool_call_end':                       ← result + error + durationMs
        this.push(...); return;
      case 'model_usage':                         ← fills the once-orphaned
        this.push(persistMessage(pool, conversationId, 'model_usage', '', {
          tokensUsed: (event.inputTokens ?? 0) + (event.outputTokens ?? 0), ...
        })); return;
      case 'warning': case 'error':               ← surfaced, not dropped
        this.push(persistMessage(pool, conversationId,
          event.type, event.message, { createdAt: at })); return;
    }
  }
       │
       └─ the push-without-await IS the pattern. Make emit async and you
          stall aptkit's loop on every DB round trip. (load-bearing)
          NEW: the switch is exhaustive over all 6 variants — every event
          type lands a row, so the trajectory is fully replayable.
```

```
  src/supabase-trace-sink.ts  (flush, lines 91-93) — collect

  async flush(): Promise<void> {
    await Promise.all(this.pending);              ← the barrier: every queued
  }                                                  write must land before the
                                                     pool closes
       │
       └─ called at src/session.ts:63 inside every ask(), BEFORE close()
          ever runs pool.end() (src/session.ts:73). Flush per turn, close
          once — drain before the pool dies or the trace's tail is lost.
```

```
  src/session.ts  (the choreography, lines 55-74)

  const trace = new SupabaseTraceSink({ pool, conversationId });  ← built ONCE
  const agent = new RagQueryAgent({ model, tools, profile, trace });
  return {
    async ask(question) {
      await persistMessage(pool, conversationId, 'user', question);
      const answer = await agent.answer(question); ← emit() fires N times in here
      await trace.flush();                          ← barrier: drain THIS turn
      ...                                            (then best-effort memory)
      return answer;
    },
    async close() { await pool.end(); },           ← pool closes once, on /exit
  };
       │
       └─ flush() is per-turn (inside ask), pool.end() is once (in close).
          The sink and conversation are long-lived across the chat — a
          shift from the old per-call one-shot. (src/session.ts)
```

---

## Elaborate

This is the classic impedance mismatch between a synchronous observer/callback
interface and asynchronous side effects — the same problem as a sync event emitter
whose handlers want to do I/O. The general solutions are: (a) make the interface
async (not available here — aptkit froze `emit` as sync), (b) fire-and-forget and
hope the writes finish (loses data on process exit), or (c) fire-and-collect with a
deferred barrier, which is what buffr chose. Option (c) is the only one that both
honors the sync contract *and* guarantees durability, at the cost of a `flush` the
caller must remember. The neighbor pattern is `01-adapter-behind-a-contract.md`:
both are buffr implementing an aptkit contract, but `VectorStore` is a clean
request/response while `CapabilityTraceSink` forces this sync/async juggling.

---

## Interview defense

**Q: Why not just make `emit` async and await the write inside it?** Because
aptkit's `CapabilityTraceSink.emit` is typed to return `void`, synchronously — the
agent loop calls it inline between reasoning steps and doesn't await it. If `emit`
returned a promise, aptkit would ignore it (floating promise) and you'd be back to
fire-and-forget with no barrier — worse than what's here. The sync signature is
fixed by the contract; the queue is how you live within it.

```
  async emit (rejected)            queue + flush (chosen)
  ───────────────────              ──────────────────────
  emit returns Promise             emit returns void (contract-honest)
  aptkit ignores it (floating)     pending[] holds the handle
  no barrier → lost on exit        flush() is the barrier → durable
```

**Q: What's the load-bearing part people forget?** The `flush()` barrier *and its
ordering relative to `pool.end()`*. Everyone gets the queue; the bug is closing the
pool before draining it. With the long-lived session this is sharper: `flush()`
runs inside every `ask()` (`src/session.ts:63`), `pool.end()` runs once in
`close()` (`src/session.ts:73`) — fired by the Ink UI's `/exit`
(`src/cli/chat.tsx:18-20`). Flush each turn, close once. Naming that ordering is
the signal you've run this and watched a trace go missing.

**Q: What's the failure mode this design doesn't handle yet?** A rejected write.
`Promise.all` short-circuits on the first rejection, so one failed `persistMessage`
makes `flush` throw and leaves the other writes' fate undefined. For a bounded
single-device conversation that's acceptable; under load you'd switch to
`Promise.allSettled` and surface the partial failures. Honest gap, right call for
now.

---

## Validate

1. **Reconstruct:** name the three kernel parts and what each breaks if removed.
   (queue / un-awaited-write / single-drain — see Move 2.)
2. **Explain:** why must `emit` return `void` and not `Promise<void>`?
   (`src/supabase-trace-sink.ts:27`; aptkit's contract is synchronous.)
3. **Apply:** the agent runs an unbounded loop. What grows without bound, and which
   hardening layer fixes it? (`pending[]`; backpressure/bounded buffer — Move 2.)
4. **Defend:** a reviewer moves `pool.end()` so it can run before a turn's
   `trace.flush()` resolves "to release the pool sooner." Show them the bug.
   (`src/session.ts:63` flush vs `:73` close.)

---

## See also

- `audit.md` — Lens 6 (errors: the un-hardened `Promise.all`), Lens 2 (depth).
- `01-adapter-behind-a-contract.md` — the sibling aptkit-contract implementation.
- `04-dependency-as-a-boundary.md` — both sinks implement aptkit ports.
- `study-system-design` → trajectory capture at the architecture altitude.
