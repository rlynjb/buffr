# Shared State, Races, and Synchronization — why buffr is almost race-free

**Industry name(s):** data races, interleaving, serialization, the busy-flag guard · **Type:** Industry standard

## Zoom out, then zoom in

Most race conditions need two things: shared mutable state, and two flows of control touching it at once. buffr has very little of either — one thread (no preemption mid-statement) and a UI that refuses to start a second turn while one is running. So this file is mostly the story of *why the races don't happen*, plus the one spot where genuine concurrency exists and how it stays safe by owning nothing.

```
  Zoom out — where shared state could live

  ┌─ UI layer (chat.tsx) ─────────────────────────────────────────┐
  │  React state: turns[], input, busy  ← single-thread, serial   │ ← guard lives here
  └───────────────────────────────┬───────────────────────────────┘
                                  │  busy flag gates the next turn
  ┌─ Session layer (session.ts) ──▼───────────────────────────────┐
  │  one conversation, one agent — reused, not mutated concurrently│
  └───────────────────────────────┬───────────────────────────────┘
                                  │  the ONE concurrent spot:
  ┌─ Trace sink (parallel inserts) ▼──────────────────────────────┐
  │  pending[]: append-only, never read until flush — race-free   │
  └────────────────────────────────────────────────────────────────┘
```

Zoom in: the question here is *what stops two writers from clobbering each other?* In a single-threaded I/O app the answer is usually "the runtime, for free" — but not always, and naming the two places it could go wrong is the lesson.

## Structure pass

**Layers.** Three: **UI state** (React), **session state** (the held conversation/agent), **trace concurrency** (the parallel inserts).

**Axis: state ownership — "who can write this, and can two writes interleave?"**

```
  One axis — "can two writes interleave?" — traced down

  ┌──────────────────────────────────────────────┐
  │ UI: setTurns / setBusy — one thread, serial   │  → NO interleave (guarded too)
  └───────────────────────┬────────────────────────┘
       ┌──────────────────────────────────────────┐
       │ session: conversationId fixed; agent reused│  → NO concurrent mutation
       └───────────────────────┬───────────────────┘
            ┌─────────────────────────────────────┐
            │ trace pending[]: N async inserts      │  → CONCURRENT, but append-only
            └─────────────────────────────────────┘   so still safe

  the only concurrency that exists shares nothing mutable-and-read
```

**The seam: the `busy` flag in the chat UI.** On one side, a turn is in flight and the input box is gone; on the other, the UI is idle and accepting. That flag is the synchronization primitive that turns a UI that *could* fire overlapping `ask()` calls into one that can't.

## How it works

### Move 1 — the mental model

You know the classic React bug where a user double-clicks "submit" and you fire two requests? The fix is a disabled/loading flag that ignores the second click until the first resolves. That *is* buffr's concurrency control. There's no mutex, no lock — just a boolean that says "a turn is running, don't start another."

```
  The pattern — a busy flag serializes turns

  idle ──submit──► busy=true ──run ask()──► busy=false ──► idle
   ▲                  │
   │            submit while busy?
   └──────── ignored (early return) ──────────────────────────
```

### Move 2 — the walkthrough

**The busy flag is the whole synchronization story for turns.** In `chat.tsx`, `onSubmit` bails immediately if a turn is running, then sets `busy` for the duration:

```ts
// src/cli/chat.tsx:15-35
const onSubmit = async (value: string): Promise<void> => {
  const q = value.trim();
  if (busy) return;                    // ← guard: refuse to overlap a running turn
  // ...handle /exit, empty
  setBusy(true);                       // ← claim the "lock"
  try {
    const answer = await session.ask(q);
    setTurns((t) => [...t, { role: 'buffr', text: answer }]);
  } catch (err) { /* push error turn */ }
  finally {
    setBusy(false);                    // ← release, always
  }
};
```

Because there's only one thread and one user typing into one input, this guard is enough to guarantee `session.ask()` is never re-entered. The `finally { setBusy(false) }` mirrors the `finally { client.release() }` pattern from `01` — same shape, different resource: claim, use, always release. Note the render also *removes* the input box while busy (`src/cli/chat.tsx:48-56`), so there isn't even an input to submit into mid-turn — belt and suspenders.

**The React state updates are functional, which sidesteps stale-closure races.** Every `setTurns` uses the updater form:

```ts
// src/cli/chat.tsx:25, 29, 31
setTurns((t) => [...t, { role: 'you', text: q }]);
```

Passing `(t) => [...t, …]` instead of `[...turns, …]` means React hands you the *latest* array, not the one captured when the closure was created. If two updates queued in the same tick (they don't here, but the pattern protects you), neither would clobber the other. This is the React-flavored version of "don't read-then-write shared state non-atomically."

**The one genuinely concurrent place owns nothing mutable-and-shared.** The trace sink fires *N* inserts that run at the same time (→ `03`). The shared object is `pending[]` — but it's only ever *appended to* during `emit()` and only ever *read* once, in `flush()`, after the agent run is done:

```ts
// src/supabase-trace-sink.ts:87-93
private push(p: Promise<void>): void { this.pending.push(p); }   // append only
async flush(): Promise<void> { await Promise.all(this.pending); } // read once, at the end
```

There's no read-modify-write on `pending` interleaved with the inserts, and the inserts themselves write to *different rows* in Postgres (each is a fresh `INSERT`). So even though the inserts are concurrent, there's no shared mutable cell they fight over. The one ordering concern — "will rows land out of order?" — is solved not with a lock but by stamping `created_at` from the *event* timestamp, so replay order is deterministic regardless of which insert's socket settles first:

```ts
// src/supabase-trace-sink.ts:55-59 — order comes from the data, not the race
const at = event.timestamp;
// ...createdAt: at  → persisted into created_at (src/supabase-trace-sink.ts:26-30)
```

That's the clever bit: instead of synchronizing the writers, they made the *order independent of the writers*. The comment at `src/supabase-trace-sink.ts:46-48` says exactly this — "replay order matches emit order rather than the race between concurrent flush inserts."

**The boundary condition: what would actually introduce a race.** Two things, neither present today. First, removing the `busy` guard would let overlapping `ask()` calls share the one `conversationId` and interleave their trace emits into the same conversation — messy, not corrupting, but wrong. Second, if `pending[]` were ever *read and cleared* mid-flight (e.g. a `flush` that spliced the array while `emit` appended), you'd get a lost-update race on the array. The current code dodges both by construction. → `07` notes that `pending[]` is also *unbounded*, a different problem (memory/backpressure, not correctness).

### Move 3 — the principle

In a single-threaded async runtime, you don't get data races on individual statements — run-to-completion (→ `03`) guarantees no statement is interrupted mid-flight. What you *can* still get is *logical* races: two async flows touching the same state across `await` points. buffr defeats those two ways — serialize the flows (the busy flag) or make the shared state append-only and order-independent (the trace sink). Locks are the heavy tool; most app-level concurrency is solved with one of those two lighter moves.

## Primary diagram

```
  buffr — synchronization, all three layers

  ┌─ UI: chat.tsx ──────────────────────────────────────────────────────┐
  │  busy=false ──submit──► busy=true ──► (input box hidden) ──► ask()    │
  │      ▲                                                       │        │
  │      └──────────── finally setBusy(false) ◄──────────────────┘        │
  │  setTurns((t)=>...) functional updates — no stale-closure clobber     │
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │ one ask() at a time
  ┌─ Session: one conversationId, agent reused (no concurrent mutation) ──┐
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │ during the run, trace emits fan out
  ┌─ Trace sink: pending[] append-only ───────────────────────────────────┐
  │  emit→push (append)   ×N concurrent inserts → different rows           │
  │  flush→Promise.all (read once)   order from event.timestamp, not race  │
  └────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The reason "single-threaded means no races" is a *half*-truth worth understanding precisely: it's true for shared-memory data races (the kind `Atomics`/mutexes exist to prevent), because there's no preemption — your statement finishes before any other code runs. It's *false* for logical/interleaving races across `await` boundaries, because between `await x` and the next line, arbitrary other async work can run and mutate shared state. The canonical bug is a check-then-act split by an await (`if (!cache[k]) { await fetch(); cache[k] = … }` firing twice). buffr's busy flag is precisely a check-then-act guard, but it's safe because the check and the `setBusy(true)` happen synchronously *before* any await — no window to interleave. That's the detail that makes it correct, and it's the thing to point at in an interview. `Atomics`/`SharedArrayBuffer`/worker-thread synchronization are *not yet exercised* — they only become relevant once buffr has shared memory across threads, which it doesn't.

## Interview defense

**Q: buffr is single-threaded — so it has no race conditions, right?**
No — that's a half-truth. Single-threaded kills *shared-memory data races* (no statement is interrupted mid-flight). But *logical* races across `await` boundaries are still possible: two async flows can interleave around an await. buffr prevents them with the `busy` flag, and crucially the check-and-set happens synchronously before any await, so there's no interleave window.

```
  if (busy) return; setBusy(true);   ← both sync, no await between
  ── await session.ask() ──          ← interleave only possible here, but
                                        guard already claimed
```
Anchor: *the guard is safe because check-then-claim is atomic w.r.t. the event loop.*

**Q: The trace sink fires N concurrent inserts — how is that not a race?**
Because the shared state (`pending[]`) is append-only and read exactly once at flush, and the inserts write different rows. Ordering is solved without synchronization: `created_at` is stamped from `event.timestamp`, so replay order is the emit order regardless of which insert's socket settles first.

```
  emit→append (write-only)   flush→Promise.all (read-once)
  order from event.timestamp, NOT from insert completion order
```
Anchor: *make the order independent of the writers instead of synchronizing them.*

## See also

- `03-event-loop-and-async-io.md` — run-to-completion is why no statement interleaves
- `07-backpressure-bounded-work-and-cancellation.md` — `pending[]` is safe but unbounded
- `05-memory-stack-heap-gc-and-lifetimes.md` — the closures that hold this state alive across turns
