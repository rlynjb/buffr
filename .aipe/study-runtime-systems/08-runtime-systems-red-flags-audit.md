# 08 · Runtime Systems Red-Flags Audit

**Ranked execution-model risks, grounded in the repo** · *Project-specific audit*

---

## Zoom out, then zoom in

This file ranks every runtime risk in buffr by consequence, with `file:line`
evidence for each. The honest frame up front: buffr is a single-user laptop CLI,
so most of these "risks" are *correct decisions for the current scale* that
become real problems only when the process model changes (unattended execution,
a supervisor, larger inputs, multiple users). Each verdict names both the risk
*and* the trigger that activates it.

```
  Zoom out — risk severity across the runtime

  ┌─ External-call layer ────────────────────────────────────────┐
  │  ★ #1 no timeout → forever hang ★   ← sharpest, always-on risk │
  └───────────────────────────────┬───────────────────────────────┘
  ┌─ Resource layer ──────────────▼──────────────────────────────┐
  │  #2 pool.end() skipped on error · #3 Promise.all fail-fast    │
  └───────────────────────────────┬───────────────────────────────┘
  ┌─ Scale layer ─────────────────▼──────────────────────────────┐
  │  #4 unbounded reads/writes · #5 no shutdown signal handling   │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: a red-flags audit is a *ranked* list, not a flat tour. The top item is
the one that bites in normal use; the bottom items bite only at scale buffr
doesn't have yet.

---

## Structure pass

**Axis traced — "does this hurt now, or only at future scale?"**

```
  "when does this risk actually fire?"

  ┌──────────────────────────────────────────────┐
  │ #1 no timeout    → fires the first time Ollama │  NOW (any real use)
  │                    stalls — already possible    │
  └──────────────────────────────────────────────┘
      ┌──────────────────────────────────────────┐
      │ #2 pool.end err → fires on any thrown error│  NOW (mild — OS cleans up)
      │ #3 Promise.all  → fires on any failed write │  NOW (mild)
      └──────────────────────────────────────────┘
          ┌──────────────────────────────────────┐
          │ #4 unbounded   → fires on large input  │  AT SCALE
          │ #5 no signals  → fires under supervisor │  AT SCALE
          └──────────────────────────────────────┘
```

The severity axis splits cleanly: #1 is a live risk in everyday use; #2–#3 fire
now but the OS softens them; #4–#5 wait for a scale buffr hasn't reached.

---

## The ranked findings

### #1 — No timeout or cancellation on external calls → forever hang

**Verdict: the one real, always-on risk.** Every Ollama and Postgres call is
awaited with no timeout and no `AbortSignal`. If Ollama is reachable but stalled
(model loading, GPU contention), `await agent.answer(question)` never resolves
and never rejects — the event loop stays non-empty and the process hangs
indefinitely. A user has to `kill` it.

- **Evidence:** `src/cli/ask-cmd.ts:34` (`await agent.answer`),
  `src/cli/index-cmd.ts:24` (`await indexDocumentRow`), `src/pg-vector-store.ts:70`
  (`await this.pool.query` in `search`) — none carry a `signal` or deadline.
- **Trigger:** already live. Any real Ollama stall hangs the run.
- **Fix:** race each external call against a timeout that aborts via
  `AbortController`. → full treatment in `07`.

### #2 — `pool.end()` skipped on the error path → no graceful drain

**Verdict: real but soft — the OS covers for it.** `pool.end()` is the *last
line* of every CLI, not inside a `finally`. Any throw above it — a failed query,
a dimension mismatch, an Ollama error — jumps past it and the process exits with
the pool's sockets still open. Process exit reaps them, so it's not a classic
leak, but it's not a clean drain either, and it compounds with #1 (a hung call
never even *reaches* the throw).

- **Evidence:** `src/cli/ask-cmd.ts:38`, `src/cli/index-cmd.ts:27`,
  `src/cli/eval-cmd.ts:34`, `src/migrate.ts:30` — all bare last-line `pool.end()`,
  no `try/finally`.
- **Note the contrast:** the *inner* resource is handled correctly —
  `client.release()` IS in a `finally` (`src/pg-vector-store.ts:64`,
  `src/migrate.ts:18`). Only the pool-level close lacks it.
- **Trigger:** any thrown error during a run.
- **Fix:** wrap each CLI body in `try { ... } finally { await pool.end(); }`.
  → `06`.

### #3 — `flush()` uses `Promise.all` → one failed trace write rejects the batch

**Verdict: real but minor.** `SupabaseTraceSink.flush()` awaits
`Promise.all(this.pending)`. `Promise.all` is fail-fast: the first rejected
trace write rejects the whole `flush`, which throws past `pool.end()`
(compounding #2) and aborts the rest of the drain. A single transient write
failure loses the *whole* trace and leaks the pool.

- **Evidence:** `src/supabase-trace-sink.ts:38` (`await Promise.all(this.pending)`).
- **Trigger:** any single failed `persistMessage` during a run.
- **Fix:** `Promise.allSettled` to drain everything regardless, then inspect
  failures. → `03`.

### #4 — Unbounded whole-file reads and unbounded trace writes

**Verdict: correct now, breaks at input scale.** Two unbounded allocations.
First, `readFile(path, 'utf8')` (`src/cli/index-cmd.ts:23`) loads each file
*whole* into a heap string before chunking — peak heap tracks the largest file,
unbounded in file size. Second, the trace sink fires one write per event into
`pending[]` with no cap (`src/supabase-trace-sink.ts:27`) — N events = N
concurrent promises.

- **Evidence:** `src/cli/index-cmd.ts:23` (whole-file read),
  `src/supabase-trace-sink.ts:24,27` (uncapped `pending[]`).
- **Trigger:** a multi-hundred-MB file, or an agent emitting thousands of events.
- **Fix:** stream large files (`createReadStream` + chunk); cap in-flight trace
  writes. → `05`, `07`.

### #5 — No `SIGINT`/`SIGTERM` handling → Ctrl-C kills mid-transaction

**Verdict: correct for a laptop, required under supervision.** No
`process.on('SIGINT'/'SIGTERM')` anywhere. Ctrl-C during a run kills the process
immediately — possibly mid-write, mid-transaction — with no flush, no commit.
The `flush()`-before-exit path (`03`) covers *normal* exit only; signal-driven
exit bypasses it entirely.

- **Evidence:** no `process.on(...)` in any file under `src/`. Normal-exit drain
  is `src/cli/ask-cmd.ts:35` (`await trace.flush()`).
- **Trigger:** running under a supervisor/orchestrator that sends `SIGTERM`, or a
  user who Ctrl-Cs a long run and expects clean teardown.
- **Fix:** register a handler that flushes the sink, ends the pool, then exits.
  → `07`.

---

## What's correct — not every absence is a flag

The audit would be dishonest without this. Several "missing" things are *right*:

- **Single-threaded, no workers** (`02`) — correct: all heavy compute is remote
  (Ollama), so the JS thread never blocks. A worker would add complexity for no
  gain.
- **Client `release()` in `finally`** (`pg-vector-store.ts:64`, `migrate.ts:18`)
  — the inner resource lifecycle is textbook-correct.
- **Transactions on multi-write paths** (`upsert`, `runMigration`) — atomicity
  where it matters, autocommit `pool.query` where it doesn't (`04`).
- **`--test-concurrency=1`** (`package.json`) — deliberate serialization of a
  shared test database; the right trade of speed for determinism (`04`).
- **`flush()` before `pool.end()`** (`ask-cmd.ts:35`) — the normal-exit drain is
  correctly ordered (`03`).
- **`assertDim` before any pool access** (`pg-vector-store.ts:33,39,68`) — a bad
  768-dim vector throws before it ever opens a transaction.

---

## Primary diagram

```
  Runtime risk map — ranked, with triggers

  SEVERITY    FINDING                         EVIDENCE              FIRES
  ─────────   ────────────────────────────    ──────────────────    ──────────
  ★ HIGH      #1 no timeout → forever hang     ask-cmd.ts:34         NOW
  ─────────   ────────────────────────────    ──────────────────    ──────────
    MEDIUM    #2 pool.end skipped on error     ask-cmd.ts:38         NOW (soft)
    MEDIUM    #3 Promise.all fail-fast flush   trace-sink.ts:38      NOW (minor)
  ─────────   ────────────────────────────    ──────────────────    ──────────
    LOW       #4 unbounded reads/writes        index-cmd.ts:23       AT SCALE
    LOW       #5 no SIGINT/SIGTERM handler     (absent in src/)      AT SCALE

  CORRECT-AS-IS: single thread · finally release · transactions ·
                 --test-concurrency=1 · flush-before-end · assertDim guard
```

---

## Implementation in codebase

**Use cases.** This audit is reached for before changing buffr's process model —
making it run unattended, under a supervisor, or against larger corpora. Each
finding's trigger tells you which change activates which risk.

**The #1 risk, in one place** (`src/cli/ask-cmd.ts`, line 34):

```
  src/cli/ask-cmd.ts  (line 34)

  const answer = await agent.answer(question);   ← no signal, no deadline
       │
       └─ the entire run's upper time bound is "whenever Ollama feels like
          responding." A stall here is unrecoverable without an external kill.
          This is the only HIGH-severity, fires-in-normal-use finding.
```

**The #2/#3 compound** (`src/cli/ask-cmd.ts`, lines 35–38):

```
  src/cli/ask-cmd.ts  (lines 35-38)

  await trace.flush();          ← #3: Promise.all here rejects on first failed write
  process.stdout.write(...);
  await pool.end();             ← #2: skipped if flush() (or anything above) throws
       │
       └─ a single failed trace write rejects flush, throws past pool.end, and
          the pool's sockets are torn down by process exit instead of drained.
          Two soft findings that compound into "trace lost + pool not drained."
```

---

## Elaborate

The pattern across every finding is the same: **buffr is correct for its stated
scope (single-user laptop, short-lived processes) and the risks are all
"what changes when the scope changes."** That's the honest shape of a young
project's runtime — not bugs, but unstated assumptions about how it'll be run.
The audit's value is making those assumptions explicit so the day buffr graduates
to unattended or supervised execution, the fix list is already written.

The one finding that *isn't* scale-gated is #1 — a missing timeout is a live risk
the moment any external dependency is flaky, which is always. That's why it ranks
first: it doesn't wait for scale, it waits for Ollama to have a bad day.

For the full teaching of each risk's mechanism, follow the cross-links: `01`
(the resource map every finding sits on), `03` (the flush/event-loop seam behind
#2/#3), `04` (the synchronization that's correct), `05` (the unbounded
allocations in #4), `06` (the pool lifecycle behind #2), `07` (the bounded-work
and cancellation gaps behind #1/#4/#5).

---

## Interview defense

**Q: What's the single biggest runtime risk in this codebase?**

```
  the forever hang

  await agent.answer ──► Ollama (stalls) ──► await never settles
        │                                          │
        └─ no timeout, no AbortSignal ─────────────┘ → process hangs forever
```

No timeout or cancellation on external calls (`ask-cmd.ts:34`). A stalled Ollama
hangs the whole process with no recovery but `kill`. It ranks first because it's
the only finding that fires in *normal* use, not just at scale. *Anchor:* a call
with no deadline is an unbounded commitment.

**Q: Is `pool.end()` not being in a `finally` a bug?** It's a soft one. On the
error path it's skipped (`ask-cmd.ts:38`), but process exit reaps the sockets, so
no classic leak — just no graceful drain. The fix is a one-line `try/finally`.
Worth noting the *inner* resource is handled right: `client.release()` IS in a
`finally`. *Anchor:* outer cleanup leaks on error, inner cleanup is correct —
name the asymmetry.

---

## Validate

1. **Reconstruct:** list the five findings ranked, and for each name whether it
   fires NOW or AT SCALE.
2. **Explain:** why does #1 (no timeout) outrank #4 (unbounded reads) in
   severity, given both are "missing bounds"?
3. **Apply:** you're about to run buffr's CLIs from a cron-style supervisor that
   sends `SIGTERM`. Which findings just got more dangerous, and why?
4. **Defend:** pick the finding you'd fix *first* and justify the ordering
   against the others using the now-vs-scale axis.

---

## See also

- `01-runtime-map.md` — the resource map every finding sits on
- `03-event-loop-and-async-io.md` — the flush seam behind #2/#3
- `06-filesystem-streams-and-resource-lifecycle.md` — the pool lifecycle behind #2
- `07-backpressure-bounded-work-and-cancellation.md` — the bounded-work/cancellation gaps behind #1/#4/#5
- `00-overview.md` — the ranked findings and not-yet-exercised list
