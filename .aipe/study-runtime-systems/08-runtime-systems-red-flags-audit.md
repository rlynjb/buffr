# 08 · Runtime Systems Red-Flags Audit

**Ranked execution-model risks, grounded in the repo** · *Project-specific audit*

---

## Zoom out, then zoom in

This file ranks every runtime risk in buffr by consequence, with `file:line`
evidence for each. The honest frame up front: buffr is a single-user laptop tool,
and its primary path is now a long-lived interactive process (`npm run chat`),
not a one-shot CLI. That shift *activated* two risks that used to be theoretical
— the no-timeout hang is now user-visible (it wedges the chat UI), and the
missing signal handler now matters because Ctrl-C is the natural way to quit a
long-lived process. The batch CLIs (`index`, `eval`, `migrate`) keep the older
one-shot shape. Each verdict names both the risk *and* the trigger that activates
it.

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
  │ #1 no timeout    → Ollama stalls → wedges the  │  NOW (any chat turn)
  │                    chat UI — already possible   │
  └──────────────────────────────────────────────┘
      ┌──────────────────────────────────────────┐
      │ #5 no signals  → Ctrl-C out of chat skips  │  NOW (chat: common quit)
      │                  session.close() drain      │
      │ #2 pool.end     → fires on throw / non-/exit│  NOW (mild — OS cleans up)
      │ #3 Promise.all  → fires on any failed write │  NOW (mild)
      └──────────────────────────────────────────┘
          ┌──────────────────────────────────────┐
          │ #4 unbounded   → large input OR long   │  NOW (chat) / AT SCALE (input)
          │                  chat session           │
          └──────────────────────────────────────┘
```

The severity axis shifted with the long-lived chat process: #1 is a live,
*user-visible* risk every chat turn; #5 went from a supervisor-only concern to a
common one (Ctrl-C is how you quit); #2–#3 fire now but the OS softens them; #4
is now partly session-scaled (`turns[]`) rather than purely input-scaled.

---

## The ranked findings

### #1 — No timeout or cancellation on external calls → forever hang

**Verdict: the one real, always-on risk — now user-visible.** Every Ollama and
Postgres call is awaited with no timeout and no `AbortSignal`. If Ollama is
reachable but stalled (model loading, GPU contention), `await
agent.answer(question)` (`session.ts:62`) never resolves and never rejects. In
chat that means `session.ask` never returns, the `finally` that clears `busy`
(`chat.tsx:32-34`) never runs, the spinner spins forever, and the busy guard
locks all input — a wedged UI the user must `kill` from another terminal.

- **Evidence:** `src/session.ts:62` (`await agent.answer`),
  `src/cli/index-cmd.ts:24` (`await indexDocumentRow`), `src/pg-vector-store.ts:70`
  (`await this.pool.query` in `search`) — none carry a `signal` or deadline.
- **Trigger:** already live, and now *interactive* — any Ollama stall during a
  chat turn wedges the UI, not just a background run.
- **Fix:** race each external call against a timeout that aborts via
  `AbortController`; bind a key to cancel the in-flight turn. → full treatment in
  `07`.

### #2 — `pool.end()` reached only on the graceful path → no drain on abnormal exit

**Verdict: real but soft — the OS covers for it.** In the batch CLIs `pool.end()`
is the *last line*, not inside a `finally`; a throw above it skips the drain. In
chat it's inside `session.close()` (`session.ts:72-73`), reached only when the
user types `/exit` (`chat.tsx:18-20`) — so a SIGINT, a crash, or an unhandled
error all bypass it. Process exit reaps the sockets, so it's not a classic leak,
but it's not a clean drain either, and it compounds with #1 (a hung call never
even *reaches* `/exit`, and Ctrl-C out of the hang skips `close()`).

- **Evidence:** `src/cli/index-cmd.ts:27`, `src/cli/eval-cmd.ts:34`,
  `src/migrate.ts:30` (bare last-line `pool.end()`); `src/session.ts:73`
  (`pool.end()` reachable only via `session.close()`, called only at
  `chat.tsx:19`).
- **Note the contrast:** the *inner* resource is handled correctly —
  `client.release()` IS in a `finally` (`src/pg-vector-store.ts:64`,
  `src/migrate.ts:18`). Only the pool-level close lacks a guarantee.
- **Trigger:** any thrown error (batch) or any non-`/exit` termination (chat:
  SIGINT, crash).
- **Fix:** wrap batch CLI bodies in `try { ... } finally { await pool.end(); }`;
  register a `process.on('SIGINT')` that calls `session.close()`. → `06`.

### #3 — `flush()` uses `Promise.all` → one failed trace write rejects the batch

**Verdict: real but minor.** `SupabaseTraceSink.flush()` awaits
`Promise.all(this.pending)`. `Promise.all` is fail-fast: the first rejected
trace write rejects the whole `flush`, which throws out of `session.ask`. In chat
that throw is caught by `chat.tsx`'s `try/catch` (`:30-31`) and rendered as an
error turn — so the *session* survives, but that turn's whole trace is lost.
Two extra wrinkles now: `pending[]` is never cleared after flush
(`supabase-trace-sink.ts:91`), so a prior turn's settled promises stay in the
array; and all 6 event types now persist, so there are more writes per turn to
fail.

- **Evidence:** `src/supabase-trace-sink.ts:92` (`await Promise.all(this.pending)`),
  `:91` (no clear), caught at `src/cli/chat.tsx:30-31`.
- **Trigger:** any single failed `persistMessage` during a turn.
- **Fix:** `Promise.allSettled` to drain everything regardless, then inspect
  failures; clear `pending[]` after each flush. → `03`.

### #4 — Unbounded whole-file reads and unbounded trace writes

**Verdict: correct now, breaks at input scale — plus a new session-scoped one.**
Three unbounded allocations. First, `readFile(path, 'utf8')`
(`src/cli/index-cmd.ts:23`) loads each file *whole* into a heap string — peak heap
tracks the largest file. Second, the trace sink fires one write per event into
`pending[]` with no cap and never clears it (`src/supabase-trace-sink.ts:50,87`).
Third — new with chat — the React `turns[]` array (`src/cli/chat.tsx:11`) appends
every exchange and trims nothing, growing for the whole session. The first is
input-scaled; the latter two are now *session*-scaled in the long-lived process
(`05`).

- **Evidence:** `src/cli/index-cmd.ts:23` (whole-file read),
  `src/supabase-trace-sink.ts:50,87` (uncapped, uncleared `pending[]`),
  `src/cli/chat.tsx:11,25,29` (`turns[]` grows per turn).
- **Trigger:** a multi-hundred-MB file, an agent emitting thousands of events, or
  a chat session left open for hours.
- **Fix:** stream large files; cap + clear in-flight trace writes; window
  `turns[]`. → `05`, `07`.

### #5 — No `SIGINT`/`SIGTERM` handling → Ctrl-C skips the drain (now the normal quit path)

**Verdict: was a scale risk, now a live one for chat.** No
`process.on('SIGINT'/'SIGTERM')` anywhere. For the long-lived chat process this
moved up: `/exit` is the *only* path to `session.close()` → `pool.end()`
(`chat.tsx:18-20`), and Ctrl-C is the natural way a user abandons a stuck or
finished session. A SIGINT kills the process immediately — possibly mid-write,
mid-transaction — bypassing `session.close()` entirely. The per-turn `flush()`
(`03`) covers a *completed* turn only; a signal mid-turn drains nothing.

- **Evidence:** no `process.on(...)` in any file under `src/`. The only drain is
  `session.close()` (`src/session.ts:73`), called only at `src/cli/chat.tsx:19`.
- **Trigger:** any Ctrl-C during a chat session (common), or a supervisor sending
  `SIGTERM`.
- **Fix:** register a handler that calls `session.close()` (flush + end pool)
  then exits. → `07`.

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
- **`flush()` before the turn returns** (`session.ts:63`) — the per-turn drain is
  correctly ordered, after `agent.answer` and before handing the answer back (`03`).
- **`memory.remember` is best-effort** (`session.ts:65-69`) — wrapped in
  `try/catch` so a failed episodic-memory write can't lose the answer the user
  already has. A deliberate, correct degradation.
- **`assertDim` before any pool access** (`pg-vector-store.ts:32,39,68`) — a bad
  768-dim vector throws before it ever opens a transaction.

---

## Primary diagram

```
  Runtime risk map — ranked, with triggers

  SEVERITY    FINDING                         EVIDENCE              FIRES
  ─────────   ────────────────────────────    ──────────────────    ──────────
  ★ HIGH      #1 no timeout → wedges chat UI   session.ts:62         NOW (every turn)
  ─────────   ────────────────────────────    ──────────────────    ──────────
    MEDIUM    #5 no SIGINT → Ctrl-C skips drain session.ts:73        NOW (chat quit)
    MEDIUM    #2 pool.end only on /exit         session.ts:73        NOW (soft)
    MEDIUM    #3 Promise.all fail-fast flush    trace-sink.ts:92      NOW (minor)
  ─────────   ────────────────────────────    ──────────────────    ──────────
    LOW       #4 unbounded reads/writes/turns[] index-cmd.ts:23 ·    INPUT / SESSION
                                                chat.tsx:11

  CORRECT-AS-IS: single thread · finally release · transactions ·
                 --test-concurrency=1 · flush-before-return · best-effort memory ·
                 assertDim guard
```

---

## Implementation in codebase

**Use cases.** This audit is reached for before changing buffr's process model —
or, now that the primary path is already long-lived, before relying on `chat` for
real interactive sessions. Each finding's trigger tells you which change activates
which risk; several already fire in everyday chat use.

**The #1 risk, in one place** (`src/session.ts:62` + `src/cli/chat.tsx:26-34`):

```
  src/session.ts  (line 62)         src/cli/chat.tsx  (lines 26-34)

  const answer =                    setBusy(true);
    await agent.answer(question);   try { const a = await session.ask(q); ... }
       │ ← no signal, no deadline   finally { setBusy(false); }  ← runs only if ask resolves
       │
       └─ the turn's upper time bound is "whenever Ollama feels like responding."
          A stall means session.ask never resolves, so the finally never clears
          busy — spinner forever, input locked, no in-app escape. The only HIGH-
          severity, fires-every-chat-turn finding.
```

**The #2/#3 compound** (`src/session.ts:63` + `src/cli/chat.tsx:30-31`):

```
  src/session.ts  (line 63)         src/cli/chat.tsx  (lines 30-31)

  await trace.flush();              catch (err) { setTurns(... error ...) }
       │ ← #3: Promise.all rejects        ▲
       │   on first failed write          └─ #2: pool is NOT closed per turn (held
       │                                     warm). The throw is caught, the session
       │                                     survives, but that turn's trace is lost.
       └─ a single failed trace write rejects flush and throws out of session.ask;
          chat.tsx catches it and renders an error turn. So #3 loses one turn's
          trace instead of leaking the pool — the long-lived shape actually
          *softens* the compound versus the old per-call pool.end().
```

---

## Elaborate

The pattern across the findings has shifted with the process model. buffr used to
be entirely short-lived processes, and the risks were all "what changes when the
scope changes." Going long-lived for `chat` *was* that scope change — and it
pulled #1 and #5 from "theoretical / at-scale" into "fires in everyday
interactive use." The batch CLIs keep the old shape and the old (softer) risk
profile. The audit's value now is two-fold: name what the long-lived shape already
activated (#1 wedges the UI, #5 skips the drain on Ctrl-C, #4 grows `turns[]`
unbounded), and keep the still-correct batch decisions visible.

The finding that *isn't* gated at all is #1 — a missing timeout is a live risk the
moment any external dependency is flaky, which is always. In a long-lived
interactive process that risk is now *visible*: a stall doesn't just delay a
background run, it freezes the UI in front of the user. That's why it ranks first.

For the full teaching of each risk's mechanism, follow the cross-links: `01`
(the resource map every finding sits on), `03` (the flush/event-loop seam behind
#2/#3), `04` (the synchronization that's correct), `05` (the unbounded
allocations in #4), `06` (the pool lifecycle behind #2), `07` (the bounded-work
and cancellation gaps behind #1/#4/#5).

---

## Interview defense

**Q: What's the single biggest runtime risk in this codebase?**

```
  the forever hang — wedges the chat UI

  session.ask ─► agent.answer ─► Ollama (stalls) ─► ask never resolves
        │              │
        │ busy=true    └─ no timeout, no AbortSignal ─┘ → finally never runs
        ▼                                                  → spinner ∞, input locked
```

No timeout or cancellation on external calls (`session.ts:62`). A stalled Ollama
freezes the chat turn: `session.ask` never resolves, the `finally` that clears
`busy` (`chat.tsx:32-34`) never runs, the spinner spins, input is blocked. It
ranks first because it fires in *normal* interactive use and is now *visible* — a
wedged UI, not just a quiet background hang. *Anchor:* a call with no deadline is
an unbounded commitment.

**Q: Is `pool.end()` reachable only on `/exit` a bug?** It's a soft one made
sharper by the long-lived shape. `pool.end()` lives in `session.close()`
(`session.ts:73`), called only at `/exit` (`chat.tsx:19`), so any Ctrl-C or crash
skips the drain. Process exit reaps the sockets, so no classic leak — just no
graceful drain, and Ctrl-C is the common quit. Fix: a `process.on('SIGINT')` that
calls `session.close()`. Worth noting the *inner* resource is handled right:
`client.release()` IS in a `finally`. *Anchor:* the graceful path drains, every
other exit skips it — name the asymmetry.

---

## Validate

1. **Reconstruct:** list the five findings ranked, and for each name whether it
   fires NOW (chat), NOW (soft), or only at input scale.
2. **Explain:** why did going long-lived for `chat` pull #1 and #5 up the ranking
   without changing a line of their code?
3. **Apply:** a user Ctrl-Cs out of a stuck chat turn. Trace which findings fire
   (hint: #1 caused the stall, #5 skips the drain) and what's lost.
4. **Defend:** pick the finding you'd fix *first* for the chat path and justify
   it against the others, using "fires every turn" vs "fires on quit."

---

## See also

- `01-runtime-map.md` — the resource map every finding sits on (two process shapes)
- `03-event-loop-and-async-io.md` — the flush seam behind #2/#3
- `06-filesystem-streams-and-resource-lifecycle.md` — the `session.close()` lifecycle behind #2/#5
- `07-backpressure-bounded-work-and-cancellation.md` — the bounded-work/cancellation gaps behind #1/#4/#5
- `00-overview.md` — the ranked findings and not-yet-exercised list

---

Updated: 2026-06-24 — re-ranked for the long-lived chat process: #1 (no timeout) now wedges the chat UI (`session.ts:62` + `chat.tsx`), #5 (no SIGINT) pulled up since Ctrl-C skips `session.close()`, #4 adds session-scoped `turns[]`; re-grounded all evidence off `session.ts`/`chat.tsx`; purged ask-cmd.
