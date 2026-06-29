# Shared State, Races, and Synchronization — why one thread saves you here

**Industry name(s):** shared mutable state, race conditions, the run-to-completion guarantee, async interleaving (re-entrancy) · *Industry standard*

---

## Zoom out, then zoom in

The headline: because Node runs one thread with run-to-completion semantics, **this repo has no data races** — no two pieces of code mutate the same variable at the literal same instant. But "single-threaded" does *not* mean "no concurrency bugs." There's one real hazard class — **async re-entrancy**, where a function yields at an `await` and gets called again before it finishes — and the repo closes it with one synchronous guard.

```
  Zoom out — where shared state lives

  ┌─ Interface layer ────────────────────────────────────────┐
  │  ★ React state: turns[], input, busy (chat.tsx) ★        │ ← we are here
  └──────────────────────────┬───────────────────────────────┘
  ┌─ Runtime layer ──────────▼───────────────────────────────┐
  │  ★ pending[] (trace sink) ★  ·  session closure vars     │ ← and here
  └──────────────────────────┬───────────────────────────────┘
  ┌─ Storage layer ──────────▼───────────────────────────────┐
  │  Postgres rows — the ONE place real concurrency lands    │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: shared mutable state is any variable more than one task reads or writes. The question for each: can two tasks touch it *interleaved* in a way that corrupts it? On one thread the answer is "only across `await` boundaries" — so that's the only place to look.

---

## The structure pass

**Layers.** UI state (`turns`, `busy` — React) → runtime state (`pending[]`, the session closure) → durable state (Postgres rows). The synchronization story changes at each layer.

**Axis — trace `state` ownership + mutability: who can mutate this, and can two tasks interleave on it?**

```
  One axis, three altitudes: "can two tasks corrupt this concurrently?"

  ┌─ UI state (turns, busy) ────────┐  mutated across await in onSubmit
  │  guarded by run-to-completion + │  → safe, but needs the busy gate
  │  the synchronous busy check     │     for re-entrancy
  └──────────────────────────────────┘
      ┌─ pending[] (sink) ──────────┐  pushed across await, drained once
      │  single owner (the sink),    │  → no interleaving corruption:
      │  array push is atomic per task│     push runs to completion
      └──────────────────────────────┘
          ┌─ Postgres rows ─────────┐  THE real concurrent writer surface;
          │  many inserts in flight  │  ordering handled by created_at, not
          │  at once via the pool    │  by app-level locks
          └──────────────────────────┘
```

The answer flips at the storage layer: that's the only place where genuinely-concurrent writers (multiple in-flight inserts) hit one resource. In-process, everything is serialized by the one thread.

**Seam — the `await` point inside `onSubmit`.** The load-bearing joint (`src/cli/chat.tsx:15-35`). Before the first `await`, the function runs atomically. At each `await`, the thread yields and *another* `onSubmit` could start (the user could submit again). Control re-entrancy flips across that boundary — which is exactly why the `busy` guard sits at the top, before any yield.

---

## How it works

### Move 1 — the mental model

You know the classic React bug: two rapid clicks both fire a handler, both read stale state, the second clobbers the first. That's re-entrancy, and it's the *only* race shape Node hands you — not "two threads write at once" (impossible here) but "one function yields mid-flight and runs again before finishing." The fix is the same one you'd reach for in React: **a guard flag set synchronously before the first yield.**

```
  Async re-entrancy — the pattern shape (and its guard)

  user submits ──► onSubmit() ──► if (busy) return  ◄── the guard
                                  setBusy(true)          (synchronous,
                                  ┌──────────────┐        before any await)
                                  │ await ask(q)  │ ◄── YIELD POINT
                                  └──────────────┘     2nd submit lands here...
                                  setBusy(false)        ...but hits the guard,
                                                        returns immediately
```

Without the guard, a second submit during the `await` would run a second turn concurrently against the same session. The guard makes turns strictly serial.

### Move 2 — the walkthrough

**The `busy` guard — the one synchronization primitive in the repo.** Look at the order of operations in `onSubmit`:

```ts
// src/cli/chat.tsx:15-34 — the re-entrancy guard
const onSubmit = async (value: string): Promise<void> => {
  const q = value.trim();
  if (busy) return;                 // ← GUARD: synchronous, runs before any await
  // ... /exit handling ...
  if (!q) return;
  setInput('');
  setTurns((t) => [...t, { role: 'you', text: q }]);
  setBusy(true);                    // ← claim the lock (still synchronous)
  try {
    const answer = await session.ask(q);   // ← YIELD: thread is free, but busy===true
    setTurns((t) => [...t, { role: 'buffr', text: answer }]);
  } catch (err) {
    setTurns((t) => [...t, { role: 'buffr', text: `error: ...` }]);
  } finally {
    setBusy(false);                 // ← release the lock
  }
};
```

The critical detail: `if (busy) return` and `setBusy(true)` both run **synchronously, before the first `await`**. Run-to-completion guarantees no other task interleaves between them — so the check-then-set is atomic without any lock. By the time the thread yields at `await session.ask(q)`, `busy` is already `true`, so any second submit hits `if (busy) return` and bails. This is a mutex implemented with the loop's own serialization. (One caveat the UI sidesteps anyway: while `busy`, the `<TextInput>` is replaced by the spinner — `src/cli/chat.tsx:48-56` — so the user *can't* even submit again. The guard is belt *and* suspenders.)

**`turns[]` and `input` — React's reducer keeps them safe.** Every mutation goes through `setTurns((t) => [...t, ...])` — a functional update that reads the latest state and returns a new array, never mutating in place (`src/cli/chat.tsx:25,29,31`). Two facts make this race-free: the updater is pure, and React applies updaters in order. There's no `turns.push()` anywhere — that immutable discipline is what makes concurrent-looking updates from before/after an `await` compose correctly.

**`pending[]` — single owner, push-only across awaits.** The sink's array (`src/supabase-trace-sink.ts:50`) is mutated by `push()` from inside synchronous `emit()` calls. Even though many `persistMessage` Promises are in flight concurrently, the *array mutation* (`this.pending.push(p)`) is synchronous and runs to completion each time — no two pushes interleave. The reads happen only in `flush()` after the run. Single writer, single reader, no overlap.

```
  pending[] — why concurrent in-flight writes don't corrupt the array

  emit() ─► push(p1)  [synchronous, completes]   ┐
  emit() ─► push(p2)  [synchronous, completes]   ├─ array never half-written:
  emit() ─► push(p3)  [synchronous, completes]   ┘  each push runs to completion
       │  meanwhile p1,p2,p3 RESOLVE concurrently (the I/O, not the array)
       ▼
  flush() ─► reads pending[]  [after run, no concurrent writer]
```

**Where real concurrency actually lands: Postgres.** The one place multiple operations genuinely hit a shared resource at once is the database — several `persistMessage` inserts in flight, plus the `upsert` transaction's `begin/commit` (`src/pg-vector-store.ts:42-58`) holding one connection. The repo doesn't synchronize these in app code; it leans on two things: transactions (the upsert is all-or-nothing within one checked-out connection) and `created_at = event.timestamp` so that *replay order* is correct even though *insert order* is whatever the pool schedules. That's the right division of labor — let the database be the concurrency-control authority, don't reimplement it in JS.

### Move 2 variant — the load-bearing skeleton of the guard

The kernel of "serialize re-entrant async work":

1. **A flag read-and-set with no `await` between.** `if (busy) return; ... setBusy(true)`. *Put an `await` between the check and the set* and the guard breaks — two submits could both pass the check before either sets the flag (the check-then-act race). The whole correctness rests on those two lines being synchronous and adjacent.
2. **Release in `finally`.** `setBusy(false)` in `finally` (`src/cli/chat.tsx:33`). *Remove the `finally`* and a thrown error inside `ask` leaves `busy` stuck `true` forever — the UI deadlocks, no further input accepted.

Optional hardening: hiding the input while busy (`src/cli/chat.tsx:48`) is defense-in-depth, not the guard itself. The flag is the lock; the UI swap is courtesy.

### Move 3 — the principle

On a single-threaded event loop, **a race can only happen across an `await`** — that's the only place control yields. So synchronization collapses to one rule: do your check-and-claim synchronously, before the first yield, and release in `finally`. No mutexes, no atomics, no locks — the loop's run-to-completion *is* your mutex, as long as you never split a critical section across an `await`. The moment you do split one, you've reintroduced every concurrency bug single-threading was supposed to save you from.

---

## Primary diagram

The full synchronization picture across the three layers.

```
  Shared state & synchronization — full recap

  ┌─ UI (React, chat.tsx) ──────────────────────────────────────────┐
  │  busy: GUARD flag    if(busy)return → setBusy(true) [atomic]     │
  │  turns/input: functional setState, never mutated in place        │
  │  ── critical section: setBusy(true) ... finally setBusy(false) ──│
  └────────────────────────────┬────────────────────────────────────┘
                               │ await session.ask (yield point)
  ┌─ Runtime (sink, session) ──▼────────────────────────────────────┐
  │  pending[]: single owner, push synchronous, read once in flush   │
  │  session closure: pool/agent/conv — built once, read-only after  │
  └────────────────────────────┬────────────────────────────────────┘
                               │ many inserts in flight (concurrent)
  ┌─ Storage (Postgres) ───────▼────────────────────────────────────┐
  │  THE real concurrent surface — synchronized by:                  │
  │   · transactions (upsert begin/commit on one connection)         │
  │   · created_at = event.timestamp (replay order, not insert order)│
  └──────────────────────────────────────────────────────────────────┘
```

---

## Elaborate

The "no data races, but yes re-entrancy" distinction trips up engineers coming from threaded languages — they either over-worry (reaching for locks Node doesn't need) or under-worry (forgetting that `await` is a yield point). The discipline that fixes it is the same as React's "don't read state after an await and assume it's fresh," and the same as the check-then-act rule in any concurrent system. The repo's `busy` flag is a textbook async mutex; its reliance on Postgres transactions for the one genuinely-concurrent surface is textbook "push concurrency control down to the layer built for it."

`not yet exercised`: there's no in-process lock library (no `async-mutex`, no semaphore), and none is needed at this scale. If buffr ever ran multiple concurrent turns against one session (today the `busy` flag forbids it), or shared one mutable cache across turns, *that's* when an explicit async-mutex or a per-key lock would earn its place.

---

## Interview defense

**Q: "It's single-threaded, so there are no race conditions, right?"**

> No data races — two pieces of code can't write the same variable simultaneously, because the loop runs one task to completion. But there's still *async re-entrancy*: a function can yield at an `await` and be entered again before it finishes. In the chat UI, that's two rapid submits both starting a turn. I close it with a synchronous `if (busy) return` set before the first await, released in `finally`. The check-and-claim has to be synchronous — put an await between checking and setting the flag and the guard breaks.

```
  the race that single-threading does NOT prevent

  onSubmit#1: check busy(false) ─► [await] ─► set busy(true)
  onSubmit#2:        check busy(false) ─► ...  ← BOTH passed!
                     (only if check and set are split by an await)
  fix: check + set synchronous, adjacent, before any await
```

**Anchor:** "The async mutex is the `busy` flag — check-and-claim synchronous before the await at `src/cli/chat.tsx:18,25`, released in `finally`; the loop's run-to-completion is the lock."

---

## See also

- `02-processes-threads-and-tasks.md` — the one thread that makes this safe
- `03-event-loop-and-async-io.md` — `await` as the only yield point
- `05-memory-stack-heap-gc-and-lifetimes.md` — the immutable `turns[]` and its growth
- `08-runtime-systems-red-flags-audit.md` — the concurrency risks ranked
