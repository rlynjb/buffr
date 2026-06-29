# Runtime Systems Red Flags — ranked execution-model risks

**Industry name(s):** runtime risk audit · **Type:** Project-specific

## Zoom out, then zoom in

This is the verdict file: every execution-model risk in buffr, ranked by consequence, each grounded in a real `file:line` and labeled with whether it's a *bug*, a *deferred-but-fine* gap, or *not yet exercised*. The honest top-line: buffr has no correctness landmines in its runtime model — the risks are all "what happens when the workload grows past one local user," and they're correctly deferred for the shape it has today.

```
  Zoom out — where the risks cluster

  ┌─ Turn boundary ───────────────────────────────────────────────┐
  │  no timeout / no cancellation on a hung turn   ← rank 1        │ ← we are here:
  └───────────────────────────────┬───────────────────────────────┘   ranked risks
  ┌─ Process edge ────────────────▼───────────────────────────────┐
  │  no SIGINT handler → Ctrl-C skips cleanup      ← rank 2        │
  └───────────────────────────────┬───────────────────────────────┘
  ┌─ Internal fan-out / growth ───▼───────────────────────────────┐
  │  unbounded trace pending[] · unbounded turns[] · default pool  │
  │                                                  ← ranks 3-5   │
  └────────────────────────────────────────────────────────────────┘
```

Zoom in: the axis is *consequence* — order the risks by "what breaks, how badly, and how soon." The top two are the ones that turn into a real incident the day buffr stops being a single-user CLI.

## Structure pass

**Layers.** Risks cluster at three altitudes: the **turn boundary** (timeout/cancel), the **process edge** (signals), and **internal growth** (unbounded structures, pool defaults).

**Axis: consequence — "if this fires, what's the blast radius and when?"**

```
  One axis — "blast radius × how soon" — ranked

  rank 1  hung turn, no escape      → whole UI stuck, only Ctrl-C   (now, if Ollama stalls)
  rank 2  Ctrl-C skips cleanup      → pool not drained, TTY risk    (now, cosmetic)
  rank 3  unbounded trace pending[] → insert storm vs 10 conns      (only at high event counts)
  rank 4  unbounded turns[]         → memory O(conv length)         (only in marathon sessions)
  rank 5  default pool config       → silent ceiling of 10 conns    (only under concurrency)

  severity falls off fast — rank 1 is the only one that bites a single user today
```

**The seam: single-user-now vs multi-caller-later.** Every risk below is benign on the left of that seam and real on the right. The audit's job is to say which side buffr is on (left) and what crossing it costs.

## How it works

### Move 1 — the mental model

You know a lint report sorted by severity — errors first, then warnings, then style nits? This is that, for runtime behavior. Each finding gets a rank, an evidence anchor, a verdict (bug / deferred / not-yet-exercised), and the trigger that would escalate it. Read top-down; stop when the rank no longer matters for your deployment.

```
  The audit shape — rank · evidence · verdict · escalation trigger

  [rank] finding ──► file:line ──► verdict ──► "becomes real when X"
```

### Move 2 — the ranked findings

**Rank 1 — A hung turn has no timeout and no cancellation. (Verdict: not yet exercised; highest priority to build.)**
`await agent.answer(question)` (`src/session.ts:62`) has no deadline and no `AbortSignal`. If Ollama stalls, the turn never settles: the spinner spins forever, `busy` stays `true`, and `/exit` is gated out by `if (busy) return` (`src/cli/chat.tsx:17`) — the *only* escape is Ctrl-C killing the process. This is rank 1 because it's the one gap that can bite a single user *today* (a model still loading, a dropped connection), and the failure is total: the whole UI is stuck.

```
  agent.answer() stalls ─► no deadline ─► busy stays true ─► /exit blocked ─► kill process
```
Escalation: certain the day Ollama is remote/flaky. Fix: `Promise.race` against a timer, or thread an `AbortSignal` through (needs an aptkit-side signature change). → `07`.

**Rank 2 — No SIGINT/SIGTERM handler; Ctrl-C skips cleanup. (Verdict: deferred-but-fine for a CLI.)**
There's no `process.on('SIGINT', …)`. `/exit` drains cleanly (`session.close()` → `pool.end()`, `src/session.ts:72-75`; then Ink restores the TTY), but a Ctrl-C kills the process without running any of it (`src/cli/chat.tsx:18-21` is the *only* cleanup path). For a local single-user CLI the OS reclaims the fds, so the impact is cosmetic — a not-gracefully-drained pool and a possibly-unrestored terminal. Rank 2 because it's the second-most-likely-to-be-hit path (people Ctrl-C CLIs constantly) but low blast radius.

```
  /exit → close()→pool.end()→TTY restore ✓     Ctrl-C → no handler → skipped (OS reclaims)
```
Escalation: real the day this is a daemon/server (SIGTERM on deploy severs live work). → `06`, `07`.

**Rank 3 — The trace sink's `pending[]` is an unbounded fan-out. (Verdict: not yet exercised.)**
`emit()` pushes every event's insert promise with no cap (`src/supabase-trace-sink.ts:87-93`), and `flush` fires all of them via `Promise.all`. A turn with hundreds of events would start hundreds of concurrent inserts contending for the pool's 10 connections. In practice a turn emits a handful, so the pool's size accidentally backpressures it. Rank 3: real construction-level unboundedness, but the workload never approaches the limit.

```
  N emits → N concurrent inserts → pool(10) queues the overflow (accidental cap)
```
Escalation: long agent trajectories or batched multi-turn replay. Fix: `p-limit` cap or batch into one multi-row insert. → `03`, `07`.

**Rank 4 — `turns[]` grows unbounded with conversation length. (Verdict: not yet exercised.)**
`setTurns((t) => [...t, …])` (`src/cli/chat.tsx:25,29`) only appends; nothing trims it, and Ink re-renders the whole list each turn (`src/cli/chat.tsx:42-47`). Memory and render cost are O(conversation length). For a human-paced CLI session this never matters — you'd close it first. Rank 4: real growth, but bounded in practice by session duration.

```
  turns[]: [you][buffr][you][buffr]... append-only, full re-render each turn
```
Escalation: hours-long or programmatic sessions. Fix: window the visible history. → `05`.

**Rank 5 — The pool runs on library defaults. (Verdict: deferred-but-fine.)**
`createPool` passes only `connectionString` (`src/db.ts:4`) — so `max` is the `pg` default of 10, with no `idleTimeoutMillis`/`connectionTimeoutMillis` set. For one user issuing one query at a time that's plenty. Rank 5: lowest, because the single-turn bound (→ `04`, `07`) means buffr never approaches 10 concurrent connections except via the rank-3 fan-out — and even then the cap is benign.

```
  new pg.Pool({ connectionString }) → max:10, no timeouts (defaults)
```
Escalation: concurrent callers, or wanting fast-fail on a dead DB (set `connectionTimeoutMillis`). → `01`, `06`.

**The non-findings — what's clean and why.** Worth stating, because their absence is a design fit, not an oversight:
- *No data races.* Single thread + run-to-completion + the busy flag + append-only `pending[]` (→ `04`). Correct by construction.
- *No connection leaks on the error path.* Every explicit `connect()` has a `finally { release() }` (`src/pg-vector-store.ts:63`, `src/migrate.ts:18`) (→ `06`).
- *No blocking-the-loop hazard.* All heavy work is out-of-process I/O; no sync compute on the JS thread (→ `02`, `03`).
- *No stack-depth risk from concurrency.* Async suspension is heap, not stack (→ `05`).

### Move 3 — the principle

A clean runtime audit isn't "zero risks" — it's "every risk is named, ranked, and matched to the workload it would actually hurt." buffr's runtime model has no correctness bugs; its risks are all overload-and-escape gaps that a single upstream bound (one turn at a time) keeps dormant. The skill the audit teaches is reading risk *relative to deployment shape* — the same `pending[]` is fine for a CLI and a landmine for a server, and saying which is the whole point.

## Primary diagram

```
  buffr — runtime red flags, ranked by consequence

  ┌─ rank 1 ── turn boundary ─────────────────────────────────────────────┐
  │  agent.answer() no timeout/no cancel (session.ts:62) → UI hangs        │  build first
  └───────────────────────────────┬──────────────────────────────────────┘
  ┌─ rank 2 ── process edge ──────▼───────────────────────────────────────┐
  │  no SIGINT handler → Ctrl-C skips cleanup (chat.tsx:18-21 is only path)│  daemon-only
  └───────────────────────────────┬──────────────────────────────────────┘
  ┌─ ranks 3-5 ── growth/defaults ▼───────────────────────────────────────┐
  │  3 unbounded pending[] (sink:87-93)  4 unbounded turns[] (chat.tsx:25) │  scale-only
  │  5 default pool config (db.ts:4)                                       │
  └───────────────────────────────┬──────────────────────────────────────┘
  ┌─ clean by construction ───────▼───────────────────────────────────────┐
  │  no races · no conn leaks · no loop-blocking · no stack-depth risk     │  ✓
  └────────────────────────────────────────────────────────────────────────┘
            seam: all dormant single-user-now / real multi-caller-later
```

## Elaborate

The reason this audit ranks the way it does is that buffr's runtime risks are almost entirely *liveness* concerns (does it make progress, can it stop, does it stay bounded) rather than *safety* concerns (does it corrupt state). Safety is the harder class — races, leaks, torn writes — and buffr has none, because the single-threaded I/O model plus a serializing busy flag plus disciplined `finally`-release close all the safety holes by construction. That leaves liveness, and liveness gaps are graceful to defer: they degrade availability under stress rather than corrupting data, and they attach to one clear seam (single-user vs multi-caller). The textbook progression — add a per-turn timeout, then cancellation, then a SIGINT drain, then a concurrency cap on the fan-out — is exactly the order of the ranks above, which is not a coincidence: it's severity order *and* build order, because the worst liveness failure (a stuck turn with no escape) is also the cheapest to fix.

## Interview defense

**Q: What's the single highest-priority runtime fix in buffr, and why that one?**
A timeout (and ideally cancellation) on `await agent.answer()` (`src/session.ts:62`). It's rank 1 because it's the only gap that bites a *single* user today — if Ollama stalls, the turn hangs forever, `busy` stays true, `/exit` is gated out, and the only escape is killing the process. It's also the cheapest fix relative to its blast radius.

```
  Ollama stalls → no deadline → busy=true forever → /exit blocked → kill
  fix: Promise.race([answer, timeout])
```
Anchor: *worst liveness failure and cheapest fix — that's why it's rank 1.*

**Q: Is this codebase's runtime model risky?**
No correctness risk — no races, no leaks, no loop-blocking, all clean by construction (single thread + busy flag + `finally`-release). The risks are all *liveness* gaps — no timeout, no cancellation, no SIGINT drain, unbounded fan-out — and they're dormant because one upstream bound (one turn at a time) keeps the workload small. They become real the day buffr has a second concurrent caller.

```
  safety: ✓ clean    liveness: ✗ deferred, dormant under single-user load
```
Anchor: *the risks are overload-and-escape, ranked by deployment shape, not correctness bugs.*

## See also

- `07-backpressure-bounded-work-and-cancellation.md` — the deep walk of ranks 1, 3, 5
- `06-filesystem-streams-and-resource-lifecycle.md` — the cleanup/shutdown story behind rank 2
- `04-shared-state-races-and-synchronization.md` — why the safety column is clean
- `00-overview.md` — the map these risks hang on
