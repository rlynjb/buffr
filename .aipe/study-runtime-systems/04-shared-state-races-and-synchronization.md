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

**The `busy` guard — the one synchronization primitive in the repo.** The function is `handleSubmit` now (renamed from `onSubmit`; it also switched from reading a `value` argument to reading a ref, since the textarea's text lives in `taRef` rather than controlled React state). The synchronization shape is unchanged — same guard, same place in the function — but the completion mechanism changed: instead of `async/await` wrapped in `try/finally`, every branch now uses the two-argument `.then(success, error)` form (the same fix `03` covers for the research/review flows):

```ts
// src/cli/chat.tsx:154-169, 358-376 — the re-entrancy guard, current shape
const handleSubmit = (): void => {
  const q = (taRef.current?.plainText as string | undefined)?.trim() ?? '';
  if (busy) return;                     // ← GUARD: synchronous, runs before any await
  if (!activeFlow && !q) return;
  taRef.current?.setText('');
  // ... /exit, /help, activeFlow dispatch, etc. ...

  setTurns(t => [...t, { role: 'you', text: q }]);
  setBusy(true);                        // ← claim the lock (still synchronous)
  session.ask(q, { ... }).then(
    answer => { setTurns(t => [...t, { role: 'buffr', text: answer }]); setBusy(false); },
    err    => { setTurns(t => [...t, { role: 'buffr', text: `error: ...` }]); setBusy(false); },
  );
};
```

The critical detail is unchanged: `if (busy) return` and `setBusy(true)` both run **synchronously, before the first yield**. Run-to-completion guarantees no other task interleaves between them — so the check-then-set is atomic without any lock. What changed is *where* the release happens: instead of one `finally` clearing `busy` on both paths, each `.then()` branch clears it explicitly — success and error both do, so the guarantee holds either way, but it's now enforced by discipline (every branch remembers to call `setBusy(false)`) rather than by the language construct (`finally` can't be forgotten; a second `.then()` argument can). That's precisely the shape of hazard `03`'s R8 finding covers: the `/research`/`/review` flows initially forgot the error branch, and an unhandled rejection left `busy` stuck `true` with no `finally` to save it. `handleSubmit`'s plain-`/ask` path got the two-arg form right from the start; the flow call sites didn't, until `26f0e4b`. (While `busy`, the input is hidden behind the spinner/progress panel too — belt *and* suspenders — but the guard is what actually prevents re-entrant execution, not the hidden UI.)

**`turns[]` and `input` — React's reducer keeps them safe.** Every mutation goes through `setTurns(t => [...t, ...])` — a functional update that reads the latest state and returns a new array, never mutating in place. Two facts make this race-free: the updater is pure, and React applies updaters in order. There's no `turns.push()` anywhere — that immutable discipline is what makes concurrent-looking updates from before/after an `await` compose correctly.

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

**The mutable-trace-slot — new module-level shared state (session.ts:120-138).** Four module-level variables serve as per-turn callback slots: `currentOnStatus`, `currentOnTokens`, `currentInputTokens`, `currentOutputTokens`. They are swapped on every `ask()` call (set at entry, cleared at completion). This is shared mutable state that lives *outside* any closure — any two concurrent `ask()` calls would corrupt each other's slot. The guard that makes it safe: the `busy` flag at `chat.tsx:15` ensures only one `ask()` runs at a time. Without that UI guard, the slot pattern would be a live race: turn B's `onStatus` callback would fire during turn A's agent loop, sending live-status strings to the wrong UI turn. So the safety of this pattern is *transitive* — it depends on the `busy` flag, which means the two patterns are coupled. This is the scenario the "non-thread-safe" caveat in the session's design is about.

**Where real concurrency actually lands: Postgres.** The one place multiple operations genuinely hit a shared resource at once is the database — several `persistMessage` inserts in flight, plus the `upsert` transaction's `begin/commit` (`src/pg-vector-store.ts:42-58`) holding one connection. The repo doesn't synchronize these in app code; it leans on two things: transactions (the upsert is all-or-nothing within one checked-out connection) and `created_at = event.timestamp` so that *replay order* is correct even though *insert order* is whatever the pool schedules. That's the right division of labor — let the database be the concurrency-control authority, don't reimplement it in JS.

**The `busy` guard now also fences two multi-step closures, not just single turns.** `/research` and `/review` (`src/cli/research-flow.ts`, `src/cli/review-flow.ts`) are new since the last pass — each is a `createXFlow(session, ...)` closure holding mutable `let step`, plus flow-specific state (`collected`, `prediction`, `stake` for research; `due`, `index`, `pendingDisposition` for review) across every `await` in `start()`/`submit()`. That's the same re-entrancy shape as `onSubmit`: a multi-step exchange with the user, state mutated between awaits, and no guarantee the same closure won't be re-entered before a step finishes. `handleSubmit` in `chat.tsx` closes that gap identically to the single-turn case — `if (busy) return` before dispatching to `activeFlow.controller.submit(q)`, `setBusy(true)` before the `await`, both synchronous and adjacent. One guard, two shapes of async work (a single request/response turn, and a multi-step state machine) — the guard doesn't care which, because the hazard it closes (re-entrancy across an `await`) is identical in both.

**The journal stores confirm the pattern rather than extend it.** `InMemoryJournalStore` (`packages/kernel/src/journal/in-memory-journal-store.ts`) mutates a plain `Map` — `entries.set(id, full)`, `e.status = 'review-due'` inside a `for...of` over `.values()` — with no lock. That's safe for the identical reason `pending[]` is safe: every mutation is synchronous, so no two mutations can interleave mid-write, and the `Map` is single-owner (constructed once, referenced only by the store instance, used only in tests). `PgJournalStore` (`src/pg-journal-store.ts`) pushes its concurrency control down to Postgres exactly like `PgVectorStore` does — `listDue`'s `update ... where status = 'open' and review_at <= $4` is one atomic statement, not a read-then-write race, and every method scopes its `where` clause by `app_id`. Neither store introduces a new synchronization primitive; both confirm the repo's existing division of labor (single-thread run-to-completion in-process, transactions/atomic statements in Postgres) rather than needing a new one.

### Move 2 variant — the load-bearing skeleton of the guard

The kernel of "serialize re-entrant async work":

1. **A flag read-and-set with no `await` between.** `if (busy) return; ... setBusy(true)`. *Put an `await` between the check and the set* and the guard breaks — two submits could both pass the check before either sets the flag (the check-then-act race). The whole correctness rests on those two lines being synchronous and adjacent.
2. **Release on every terminal path.** Today that's `setBusy(false)` in *both* arguments of `.then(success, error)`, not a single `finally`. *Drop the second argument* (the error one) and a thrown error leaves `busy` stuck `true` forever — the UI deadlocks, no further input accepted. This is exactly what happened in the `/research`/`/review` flows before `26f0e4b` (`03`, `08` R8) — the skeleton part is the same whether you enforce it with `finally` or with a two-arg `.then()`; what matters is that *every* terminal path clears the flag, and the language doesn't check that for you the way it does with `finally`.

Optional hardening: hiding the input while busy is defense-in-depth, not the guard itself. The flag is the lock; the UI swap is courtesy.

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
  │  ── critical section: setBusy(true) ... .then(ok,err) both clear ─│
  │  same guard now also fences /research, /review flow closures     │
  └────────────────────────────┬────────────────────────────────────┘
                               │ await session.ask (yield point)
  ┌─ Runtime (sink, session, flows) ─▼────────────────────────────────┐
  │  pending[]: single owner, push synchronous, read once in flush    │
  │  session closure: pool/agent/conv/journal — built once, read-only │
  │  flow closures: step/collected/prediction — mutable across awaits │
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

> No data races — two pieces of code can't write the same variable simultaneously, because the loop runs one task to completion. But there's still *async re-entrancy*: a function can yield at an `await` and be entered again before it finishes. In the chat UI, that's two rapid submits both starting a turn — or, since the last pass, two rapid steps through a `/research` or `/review` flow. I close it with a synchronous `if (busy) return` set before the first yield, released on every terminal path — today that's both arguments of `.then(success, error)`, which has to cover the error path explicitly or a rejection leaves the UI stuck (that's exactly the bug `26f0e4b` fixed). The check-and-claim has to be synchronous — put an await between checking and setting the flag and the guard breaks.

```
  the race that single-threading does NOT prevent

  handleSubmit#1: check busy(false) ─► [await] ─► set busy(true)
  handleSubmit#2:        check busy(false) ─► ...  ← BOTH passed!
                     (only if check and set are split by an await)
  fix: check + set synchronous, adjacent, before any await
```

**Anchor:** "The async mutex is the `busy` flag — check-and-claim synchronous before the yield at `src/cli/chat.tsx:156,169`, released on both branches of `.then(success, error)`; the loop's run-to-completion is the lock. The same guard now fences the `/research`/`/review` flow closures too."

---

## See also

- `02-processes-threads-and-tasks.md` — the one thread that makes this safe
- `03-event-loop-and-async-io.md` — `await` as the only yield point
- `05-memory-stack-heap-gc-and-lifetimes.md` — the immutable `turns[]` and its growth
- `08-runtime-systems-red-flags-audit.md` — the concurrency risks ranked
