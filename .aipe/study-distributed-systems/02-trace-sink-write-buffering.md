# Trace-Sink Write Buffering

**Buffered async writes / fire-and-flush** · Project-specific

The one place buffr issues writes it doesn't immediately await: the trace sink
queues a write-promise per agent event, then drains them all at the end of the
run. It's the repo's only at-least-once seam — and it carries a real, mild
ordering bug.

---

## Zoom out, then zoom in

Here's where this sits. The agent loop runs in-process; as it emits events
(assistant turn, tool call), the sink turns each into a Postgres write — but
*queues* it instead of awaiting it inline, so the agent isn't blocked on the DB.

```
  Zoom out — where the trace sink lives

  ┌─ Process (ask-cmd.ts) ──────────────────────────────────────┐
  │                                                              │
  │   RagQueryAgent.answer()                                     │
  │       │ emits CapabilityEvent (sync)                         │
  │       ▼                                                      │
  │   ★ SupabaseTraceSink.emit() ★  ← we are here                │
  │       │ pushes a write-promise onto pending[]                │
  │       │ (does NOT await)                                     │
  │   ...run finishes...                                         │
  │       ▼                                                      │
  │   trace.flush()  → Promise.all(pending)                      │
  └────────────────────────────┬────────────────────────────────┘
                              writes │ pg.Pool
  ┌─ Postgres ─────────────────▼────────────────────────────────┐
  │  agents.messages  (one row per assistant / tool event)      │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **fire-and-flush** — emit synchronously, buffer the
async work, await the buffer once at the end. aptkit's `CapabilityTraceSink`
contract requires `emit` to be *synchronous* (it's called from inside the agent
loop, which can't `await` a sink). So buffr's sink can't await the write inline;
it stashes the promise and settles up later. The question this answers: *how do
you persist a side-effect stream from a synchronous callback without blocking
the producer — and what do you give up by doing it?*

---

## Structure pass

**Layers.** Two: the **producer** (the agent loop calling `emit`) and the
**writer** (the queued `persistMessage` calls hitting Postgres). The `pending[]`
array is the seam between them.

**Axis — trace *ordering guarantee* across the seam.** Hold the question:
*"is event A guaranteed to be persisted before event B if A was emitted first?"*

```
  One question across the seam: "does emit-order = persist-order?"

  ┌─ producer (agent loop) ──────────┐
  │  emit(A) then emit(B)            │  → ORDERED: A before B, deterministically
  └───────────────┬──────────────────┘
                  │  the guarantee flips here
  ┌─ pending[] + Promise.all ────────▼┐
  │  fires A's write, then B's write  │  → NOT ORDERED: both in flight at once,
  │  awaits them together             │    whichever insert wins gets earlier now()
  └───────────────────────────────────┘
```

**Seam — `pending[]` is load-bearing because the ordering answer flips across
it.** Above the array, events are strictly ordered (the loop emits them in
sequence). Below it, the two writes race: `emit(A)` fires its `persistMessage`
and immediately returns, then `emit(B)` fires its own — both are now concurrent
in-flight promises, and `agents.messages.created_at` defaults to `now()`
evaluated *at insert time on the server*. So whichever insert Postgres commits
first gets the earlier timestamp, regardless of emit order. That flip is the
whole lesson of this file.

---

## How it works

### Move 1 — the mental model

You know the difference between `await fetch()` (block until it's done) and
`void fetch()` / fire-and-forget (kick it off, move on). This is the careful
middle: **fire-and-*flush*** — kick off each write, keep the promise, then
`await Promise.all(...)` of all of them at a single join point so you don't lose
errors or exit before the writes land.

```
  Pattern — fire-and-flush (kick off, collect, join once)

  emit(A) ─► push p_A ─┐
  emit(B) ─► push p_B ─┤   pending = [p_A, p_B, p_C]   (in flight)
  emit(C) ─► push p_C ─┘
                       │
   run ends ──► flush(): await Promise.all(pending)  ← single join point
                       │
                       ▼
              all writes settled (or first rejection thrown)
```

The kernel: **a sync producer + an in-memory promise buffer + a single
join/flush.** Drop the buffer and you lose the writes (fire-and-forget). Drop
the flush and the process can exit mid-write. Keep both and the producer never
blocks — but you've **given up ordering**, because the buffer doesn't serialize.

### Move 2 — the walkthrough

**`emit` is synchronous and must not await.** Bridge from a DOM event handler:
`onClick` returns `void`, it can't be `async` and have the framework wait on it.
aptkit's `emit(event): void` is the same — the agent loop calls it and moves on.
What concretely happens: on an assistant `step` or a `tool_call_end`, the sink
builds a `persistMessage(...)` promise and `push`es it onto `pending`. It does
*not* await. Where it breaks: if you tried to `await` inside `emit`, you
couldn't — the signature is `void`. So the buffering isn't a style choice, it's
forced by the contract.

**Each write is independent and unkeyed.**

```
  Layers-and-hops — two emits, two concurrent writes

  ┌─ agent loop ─┐ emit(assistant) ┌─ sink ──────┐
  │ step A       │ ───────────────► │ push p_A    │
  │ tool B       │ emit(tool) ─────► │ push p_B    │
  └──────────────┘                  └──────┬───────┘
                          p_A insert │      │ p_B insert  (BOTH in flight)
                                     ▼      ▼
                              ┌─ Postgres agents.messages ─┐
                              │ created_at = now() @ insert │ ← race decides order
                              └─────────────────────────────┘
```

Each `persistMessage` is a bare `insert` with a server-generated UUID and a
server-evaluated `now()` (`supabase-trace-sink.ts:14-18`). There's no sequence
number, no client timestamp, no idempotency key. What concretely happens under
the race: emit-order A→B, but if B's insert commits first, B.created_at ≤
A.created_at. Where it breaks: replay the trajectory ordered by `created_at` and
the turns can come back scrambled — an "assistant" turn appearing before the
"tool" turn that preceded it.

**`flush()` is the single join point — and the only error surface.**

```
  Execution trace — flush() draining the buffer

  pending = [p_A(pending), p_B(pending)]
  flush() → Promise.all(pending)
     p_A resolves ──► pending[0] settled
     p_B rejects  ──► Promise.all REJECTS immediately with p_B's error
                      (p_A already wrote; no rollback — at-least-once)
  → flush() throws; ask-cmd.ts has no catch → process exits non-zero
```

`flush` (`:37-39`) is `await Promise.all(this.pending)`. This is load-bearing:
it's what makes the writes *at-least-once* rather than *best-effort*. Without the
`await trace.flush()` call in `ask-cmd.ts:35`, the process could `pool.end()`
and exit while writes were still in flight, dropping trajectory rows. Where it
breaks: `Promise.all` rejects on the *first* failure — so if one write fails, you
get the error but the other writes that already succeeded stay committed (no
atomicity across the batch). That's the at-least-once / partial-write reality:
some rows land, one errors, nothing rolls back.

### Move 2.5 — current state vs the fix

This is shipped and works, but the ordering quirk is a known sharp edge. The
fix is small and worth naming.

```
  Comparison — current (racy order) vs fixed (deterministic order)

  NOW                                  FIX (one of two)
  ┌──────────────────────────┐         ┌──────────────────────────────┐
  │ emit fires write, no wait │         │ A) add seq column; ORDER BY  │
  │ Promise.all (unordered)   │   →     │    seq, not created_at       │
  │ created_at races          │         │ B) chain: await prev before  │
  │ replay can scramble turns │         │    firing next (serialize)   │
  └──────────────────────────┘         └──────────────────────────────┘
  cheap, non-blocking,                  A keeps non-blocking + fixes order
  wrong order under race                B fixes order but re-blocks the loop
```

Option A (a monotonic `seq` or ordinal column, written from the producer's
counter, and sort by it on replay) is the right one: it keeps the non-blocking
fire-and-flush *and* recovers deterministic order, because order now comes from
a client-assigned sequence instead of a server-side timestamp race. Option B
(chain each write behind the previous) fixes order by re-serializing — which
gives back the blocking you were trying to avoid. At single-device,
low-event-count scale the bug rarely bites (writes usually commit in fire order
because they're tiny and sequential-ish), which is why it's shipped — but it's a
real correctness hole, not a theoretical one.

### Move 3 — the principle

Fire-and-flush is how you persist a side-effect stream from a synchronous
producer without blocking it — but **a buffer is not a queue, and "I awaited
them all" is not "they happened in order."** The moment you decouple emit from
persist, ordering becomes something you have to *assign explicitly* (a sequence
number), not something you get for free from arrival time. buffr's sink is the
smallest honest version of every async write pipeline: the at-least-once
delivery is real, the ordering guarantee is not, and the fix is to make order a
property of the data, not of the race.

---

## Primary diagram

The complete picture: sync emit, buffered concurrent writes, single flush,
at-least-once with a server-clock ordering race.

```
  Trace-sink write buffering — the complete picture

  ┌─ Producer (RagQueryAgent loop, in-process) ─────────────────┐
  │  emit(step:assistant) ─┐   emit(tool_call_end) ─┐            │
  │       │ sync, void     │        │ sync, void    │            │
  └───────┼────────────────┼────────┼───────────────┼───────────┘
          ▼                ▼        ▼               ▼
  ┌─ Buffer: pending[] (in-memory promise array) ───────────────┐
  │  [ persistMessage(A), persistMessage(B), ... ]  in flight   │
  └────────────────────────────┬────────────────────────────────┘
              flush(): Promise.all │  (single join, first-reject throws)
  ┌─ Postgres agents.messages ────▼─────────────────────────────┐
  │  N rows · UUID pk · created_at=now()@insert ← ORDER RACES    │
  │  at-least-once · unkeyed · no cross-write atomicity          │
  └─────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.** Triggered once per `ask` invocation
(`src/cli/ask-cmd.ts:29-35`): the conversation row is created up front, the
user's question is written synchronously (awaited inline — *not* buffered), then
the sink buffers every assistant turn and tool call the agent emits during
`answer()`, and `flush()` settles them before the process prints the answer and
ends the pool.

**The buffered emit — `src/supabase-trace-sink.ts` (lines 27-35).**

```
  emit(event: CapabilityEvent): void {                ← sync: aptkit's contract
    const { pool, conversationId } = this.opts;
    if (event.type === 'step' && event.role === 'assistant' && event.content) {
      this.pending.push(                               ← buffer, do NOT await
        persistMessage(pool, conversationId, 'assistant', event.content));
    } else if (event.type === 'tool_call_end') {
      this.pending.push(
        persistMessage(pool, conversationId, 'tool', event.toolName,
                       { toolResults: event.result }));
    }
  }
       │
       └─ push without await is the load-bearing line: it's what keeps the
          agent loop non-blocking. It's ALSO the bug's origin — two pushes =
          two concurrent inserts whose created_at order isn't guaranteed.
```

**The single join — `src/supabase-trace-sink.ts` (lines 37-39).**

```
  async flush(): Promise<void> {
    await Promise.all(this.pending);     ← the only place writes are awaited
  }
       │
       └─ this is what makes it at-LEAST-once instead of best-effort. Remove
          the `await trace.flush()` at ask-cmd.ts:35 and the process can
          pool.end() + exit mid-write → lost trajectory rows. Promise.all
          rejects on first failure; earlier successes stay committed (no
          cross-write rollback) — the at-least-once reality.
```

**The unkeyed write — `src/supabase-trace-sink.ts` (lines 14-18).**

```
  await pool.query(
    `insert into agents.messages (conversation_id, role, content, tool_results, model)
     values ($1, $2, $3, $4, $5)`, [...]);
       │
       └─ no idempotency key, no client sequence number. created_at comes
          from the table default now() (sql/001_agents_schema.sql:49),
          evaluated server-side at insert. That's why replay order is a
          race — the fix is a client-assigned seq column sorted on read.
```

---

## Elaborate

This pattern is the embryonic form of a **transactional outbox** without the
outbox: you're capturing a side-effect stream for later (here, trajectory rows
that the parent plan wants for eventual fine-tuning — the "capture every
conversation now" thesis in `agent-layer-plan.md`). A real outbox would write
the events to a table *inside the same transaction* as the work, then have a
relay drain them in order with delivery guarantees. buffr's sink skips all of
that because the consumer is "a human reading rows later," not another service —
but the ordering bug it has is *exactly* the bug outboxes are designed to
prevent, which is why it's worth understanding here.

What to read next: `audit.md` Lens 3 (delivery semantics) and Lens 6 (the
ordering verdict), and `01-app-to-postgres-boundary.md` for what these queued
writes do when they hit the pool. For how these rows function as the project's
primary observability artifact, see `.aipe/study-debugging-observability/` (the
trajectory-as-evidence material — not yet generated).

---

## Interview defense

**Q: "Your trace sink buffers writes and flushes with `Promise.all`. What's the
bug?"**

```
  emit-order vs persist-order

  emit:    A ──► B        (deterministic)
              ╲   ╱
               ╳         ← Promise.all doesn't serialize
              ╱   ╲
  insert:  B ──► A        (created_at race → wrong order on replay)
```

Ordering. `emit` is sync so I can't await inline — I buffer a promise per event
and `Promise.all` them at flush. But `Promise.all` doesn't serialize, so the two
inserts race, and `created_at` is a server-side `now()` at insert time — so the
persisted order can disagree with the emit order. Replaying the trajectory by
`created_at` can scramble turns. The fix is a client-assigned sequence column
sorted on read; that keeps the writes non-blocking and makes order a property of
the data instead of a race.

*Anchor: `supabase-trace-sink.ts:30` (the unawaited push) and `:38` (the unordered Promise.all).*

**Q: "Is it at-least-once, at-most-once, or exactly-once?"**

At-least-once in spirit, but really "fire-and-flush once." There's no retry, so
in practice each event is written once. But the writes aren't keyed or atomic as
a batch — if `flush`'s `Promise.all` rejects on write #3, writes #1 and #2 are
already committed and don't roll back. So: no dedup needed because no retry, but
no cross-write atomicity either. The load-bearing part people forget is the
`flush()` itself — without that single join, it'd silently drop to
best-effort/fire-and-forget and lose rows on a fast process exit.

*Anchor: `flush()` at `:37-39` is what upgrades it from best-effort to at-least-once.*

---

## Validate

1. **Reconstruct.** From memory, draw fire-and-flush: sync emit → push to
   `pending[]` → single `Promise.all` at flush. Name what breaks if you remove
   the buffer (lost writes) and if you remove the flush (mid-write exit).
2. **Explain.** Why can't `emit` just `await` the write? (Contract is
   `emit(event): void`, called sync from the agent loop.) Cite
   `supabase-trace-sink.ts:27`.
3. **Apply.** Two events emit A-then-B. Walk how B can end up with an earlier
   `created_at` than A, citing the unawaited push (`:30`), the unordered
   `Promise.all` (`:38`), and the server-side `now()` default
   (`sql/001_agents_schema.sql:49`). Then give the one-column fix.
4. **Defend.** Argue why the bug was acceptable to ship (single device, tiny
   sequential writes, human consumer) and name the exact condition that makes it
   bite (concurrency / replay-by-timestamp / the deferred multi-writer phase).

---

## See also

- `01-app-to-postgres-boundary.md` — where these queued writes actually land.
- `03-deferred-two-brain-shared-memory.md` — what at-least-once + ordering
  becomes when two devices write the same `agents.messages`.
- `audit.md` — Lens 3 (delivery semantics), Lens 6 (queues/ordering verdict),
  Lens 8 (why this is not an outbox).
- `.aipe/study-debugging-observability/` — the trajectory rows as the project's
  evidence trail (not yet generated).
