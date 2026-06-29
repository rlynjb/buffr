# 04 — Sync interface, async work

**Industry name(s):** Fire-and-collect · deferred flush · "sync emit, async
drain" · write-behind buffer. **Type:** Industry standard.

---

## Zoom out, then zoom in

aptkit's agent loop emits trajectory events *synchronously* — `emit(event)`
returns `void`, no `await`, because the loop can't stop and wait on a database
between reasoning steps. But buffr wants those events in Postgres, and a
Postgres write is *async*. `SupabaseTraceSink` bridges the impedance mismatch:
`emit()` is sync and just queues a promise; `flush()` is async and drains the
queue after the run.

```
  Zoom out — where the trace sink sits in a turn

  ┌─ Service (aptkit agent loop) ──────────────────────────────┐
  │  reason → emit(step) → call tool → emit(tool_call_end) ...  │
  │           │ sync, void, no await — the loop never blocks    │
  └───────────┼─────────────────────────────────────────────────┘
              │  push a promise (don't await)
  ┌─ buffr ──▼──────────────────────────────────────────────────┐
  │  ★ SupabaseTraceSink ★   supabase-trace-sink.ts              │ ← here
  │  emit() queues · flush() awaits all                          │
  └───────────┬─────────────────────────────────────────────────┘
              │  after the run: await flush()
  ┌─ Storage ▼──────────────────────────────────────────────────┐
  │  agents.messages   (full-signal trajectory)                 │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern decouples *when work is requested* from *when work
completes*. The interface stays sync to satisfy the contract; the work happens
async, batched and awaited at a safe point. The question: **how does the sink
honor a sync contract while doing async I/O, and what's the one thing that
breaks if you forget the flush?**

---

## Structure pass

**Layers.** The synchronous emitter above, the async DB below, the queue
between them.

```
  one axis traced: "is this call synchronous or async?"

  ┌─ aptkit loop ───────────────┐  SYNC: emit() returns void immediately
  │  emit(event)                │
  └──────────────┬──────────────┘
        seam ◄── sync/async flips here ──►
  ┌─ the pending queue ─────────▼┐  the buffer: Promise<void>[]
  │  push(p)                     │
  └──────────────┬──────────────┘
  ┌─ Postgres ───▼──────────────┐  ASYNC: each insert is a real await
  │  persistMessage → INSERT     │
  └──────────────────────────────┘
```

**Axis — "sync or async?"** The emitter side is sync (the loop demands it).
The storage side is async (I/O always is). **The flip happens at the queue** —
`emit` is sync because it only does a synchronous `array.push`; the await is
deferred to `flush`. The queue is the shock absorber between two timing
models.

**Seam.** `implements CapabilityTraceSink` (`supabase-trace-sink.ts:49`) is
the contract seam — aptkit dictates `emit(event): void`. The second seam is
`flush()` (`:91`), buffr's addition, called by the session *after* the agent
returns (`session.ts:63`). The contract gives you sync emit; buffr adds the
async drain.

---

## How it works

### Move 2 variant — the load-bearing skeleton

This concept has an irreducible kernel, so walk it as a skeleton: the smallest
thing that's still the pattern, then what breaks when each part is removed.

```
  the kernel — queue on emit, await on flush

   sync emit:                 async flush:
   ─────────                  ──────────
   pending = []               await Promise.all(pending)
   emit(e):                   ─ drains every queued write
     p = startWriteAsync(e)
     pending.push(p)   ◄── push, DON'T await
     return            ◄── sync return satisfies the contract
```

**Part 1 — the queue (what breaks: the sync contract).**

**File:** `src/supabase-trace-sink.ts` · **Lines:** 50-51, 87-89.

```ts
private readonly pending: Promise<void>[] = [];
// ...
private push(p: Promise<void>): void {
  this.pending.push(p);
}
```

A plain array of in-flight promises. This is the whole shock absorber. Remove
it and `emit` would have to `await` its write — but `emit` *can't* be async
(the contract says `void`), so without the queue you'd either block the sync
caller (impossible) or fire-and-forget with no way to know the writes
finished. The queue is what lets `emit` return instantly while still tracking
the work. **Load-bearing — it's the pattern's reason to exist.**

**Part 2 — sync `emit`, the contract face (what breaks: aptkit can't call
it).**

**File:** `src/supabase-trace-sink.ts` · **Function:** `emit` · **Lines:**
53-85.

```ts
emit(event: CapabilityEvent): void {        // ← void, no async, no await
  const { pool, conversationId } = this.opts;
  const at = event.timestamp;
  switch (event.type) {
    case 'step':
      if (event.content) {
        this.push(persistMessage(pool, conversationId, event.role, event.content, { createdAt: at }));
      }                                      // ← push the promise, return
      return;
    case 'tool_call_start': /* ... */ return;
    case 'tool_call_end':   /* ... */ return;
    case 'model_usage':     /* ... */ return;
    case 'warning':
    case 'error':           /* ... */ return;
  }
}
```

`persistMessage` returns a `Promise<void>`. `emit` calls it, pushes the
*unawaited* promise (`this.push(...)`), and returns synchronously. The agent
loop calls `emit` between reasoning steps and never blocks on the database.
The `switch` exhaustively maps all six `CapabilityEvent` types to rows —
that's the "full-signal trajectory" the comment at `:39-48` describes: tool
args (the cause), `durationMs` + error, token usage, warnings, all persisted,
not just assistant steps. **Load-bearing: the sync signature is what makes the
sink usable from a sync loop.**

**Part 3 — async `flush`, the drain (what breaks: silent data loss).**

**File:** `src/supabase-trace-sink.ts` · **Function:** `flush` · **Lines:**
91-93.

```ts
async flush(): Promise<void> {
  await Promise.all(this.pending);   // ← wait for every queued insert
}
```

The single most-forgettable part of this pattern. `emit` returned before its
writes finished; if the process exits (or the session moves on) without
`flush`, in-flight inserts are abandoned and **trajectory rows silently
vanish**. The session calls it at the right moment — `session.ts:63`, *after*
`agent.answer()` returns:

```ts
const answer = await agent.answer(question);  // emits happen in here
await trace.flush();                          // NOW drain the queue
```

This is the interview-payoff part: forgetting the flush is the bug everyone
ships first with fire-and-collect. Naming it — "the writes are queued, not
done, until you await flush" — signals you've actually run this pattern.
**Load-bearing, and the part people forget.**

**Skeleton vs hardening.** The kernel is queue + sync-emit + async-flush.
Everything else is hardening: the exhaustive `switch` (completeness, not
correctness of the pattern), the `toJsonb` stringify (`:25`, a node-postgres
quirk), the `createdAt` from event timestamp (`:26`, deterministic replay
order). You could drop all three and still have the pattern; drop the queue or
the flush and it's broken.

### Move 3 — the principle

When a contract forces a sync interface but the work is inherently async,
don't fight the contract — buffer. Queue the async work on the sync call,
return immediately, and drain at a controlled point. The cost you accept is a
discipline: *someone must call flush*, and forgetting it loses data silently.
Make the flush point obvious and single (here, one line in the session right
after the run) so the discipline is hard to skip.

---

## Primary diagram

The full sync-emit / async-flush cycle for one turn.

```
  SupabaseTraceSink — sync emit, async flush, over one turn

  ┌─ aptkit agent loop (SYNC) ──────────────────────────────────────┐
  │  step ─emit─► step ─emit─► tool_start ─emit─► tool_end ─emit─► …  │
  └────┼──────────┼─────────────┼─────────────────┼──────────────────┘
       │ push     │ push        │ push            │ push  (no awaits)
       ▼          ▼             ▼                 ▼
  ┌─ pending: Promise<void>[] ──────────────────────────────────────┐
  │   [ p1,        p2,           p3,               p4, ... ]         │
  └─────────────────────────────────┬────────────────────────────────┘
                                    │  agent.answer() returns, THEN:
                                    ▼   await trace.flush()  (session.ts:63)
  ┌─ Storage (ASYNC) ──────────────────────────────────────────────┐
  │  Promise.all → all rows land in agents.messages                 │
  │  (forget flush → these rows are lost, no error)                 │
  └─────────────────────────────────────────────────────────────────┘
```

---

## Elaborate

This is a write-behind buffer (the same idea as a DB write-back cache or a
batched logger): accept writes instantly, persist them out-of-band. The
specific constraint here is the `CapabilityTraceSink` contract's sync `emit` —
aptkit chose sync so the agent loop, which is itself sync between awaited model
calls, can instrument every step without turning every emit into a blocking
I/O point.

The honest tradeoff (audit §6): trajectory persistence is *best-effort within
the turn* — `flush` awaits everything, but if a single insert rejects,
`Promise.all` rejects and the rest are still in-flight. For a single-device
personal agent that's acceptable; trajectory rows are observability, not the
user's answer (which `session.ts` persists separately and synchronously at
`:61`). If buffr ever needed guaranteed trajectory durability, the move would
be `Promise.allSettled` plus a dead-letter retry — hardening on top of the
same kernel.

Read next: `03-dependency-as-a-boundary.md` (the `CapabilityTraceSink`
contract this implements) and `05-deep-session-facade.md` (who calls `flush`).

---

## Interview defense

**Q: Why not just make `emit` async and await each write?**
Because the contract is `emit(event): void` — aptkit's agent loop calls it
synchronously between reasoning steps and can't await it. Making the *writes*
async while keeping the *interface* sync is the only way to honor the contract
and still persist to Postgres. The queue is the bridge: push the promise on
emit, await the batch on flush.

```
  the bridge: push on emit (sync), await on flush (async)

  emit ──► pending.push(writePromise) ──► return void   (loop continues)
                       │
  flush ──► Promise.all(pending) ──► await                (run finished)
```

**Q: What's the failure mode of this pattern?**
Forgetting to flush. `emit` returns before its write completes, so if the
process ends without `await trace.flush()`, in-flight inserts are dropped and
trajectory rows vanish with no error. buffr guards it with a single obvious
flush point — `session.ts:63`, right after `agent.answer()` returns. The fix
for *guaranteed* durability would be `allSettled` + retry, but for a personal
agent the current best-effort flush is the right call.

**Anchor:** "Sync emit queues, async flush drains — and the data's not saved
until you await the flush."

---

## See also

- `audit.md` §6 (errors and special cases — the trace error-as-value).
- `03-dependency-as-a-boundary.md` — the `CapabilityTraceSink` contract.
- `05-deep-session-facade.md` — the session that owns the flush point.
