# Runtime Systems — Red-Flags Audit

**Industry name(s):** execution-model risk audit, ranked-by-consequence verdict · *Project-specific (the verdict file)*

---

## Zoom out, then zoom in

This is the verdict file. Every runtime risk in `buffr-laptop`, ranked by what actually breaks and grounded in a `file:line`. The top line changed since the last pass: **the highest-severity item on the previous audit — no SIGINT handler — is fixed.** It didn't get fixed speculatively; Ctrl-C actually hung the process, and two commits (`64f822f`, `9c1b1e6`) closed it the same day. That makes this file's most valuable teaching moment a *before/after*, not a static list: R1 shows what the fix looked like, and R8 (new) shows a second real incident-and-fix pair from the same week, this time in the event loop rather than the process lifecycle. What's left is a smaller, sharper list — most of it still deliberate single-device tradeoffs, one item (R2) now the clear top remaining gap.

```
  Zoom out — risk surfaces across the runtime

  ┌─ Interface ──────────────────────────────────────────────┐
  │  R3 no cancel key   ·  R1 SIGINT — FIXED (bounded, not     │
  │                          fully graceful) · R8 unhandled    │
  │                          rejections — FIXED                │
  └──────────────────────────┬───────────────────────────────┘
  ┌─ Runtime ────────────────▼───────────────────────────────┐
  │  R2 no per-turn deadline (now the top remaining gap)      │
  │  R4 turns[] unbounded · R6 memory.remember silent swallow │
  └──────────────────────────┬───────────────────────────────┘
  ┌─ Storage / Provider ─────▼───────────────────────────────┐
  │  R5 pool defaults (no timeout/max tuning)                 │
  │  R7 dimension mismatch throws (a GOOD flag — fail loud)   │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: a runtime red flag is anywhere the execution model can hang, leak, lose data, or grow without bound. Ranked below by consequence × likelihood at the *next* scale up.

---

## The structure pass

**Axis — `failure`: where does it originate, how far does it propagate, what contains it (if anything)?** That single axis ranks the whole list. A flag is severe when failure originates easily, propagates to lost data or a hung process, and nothing contains it.

```
  One axis ranks them: "originate → propagate → contained?"

  R1 SIGINT     easy (Ctrl-C) → forceExit() races a 1.5s deadline → BOUNDED (fixed)
  R2 timeout    medium (wedge) → turn hangs ∞                    → NOT contained
  R3 cancel     UX (mind change) → wait it out                   → NOT contained
  R4 turns[]    slow (long session) → heap climbs                → contained by /exit
  R5 pool       load (concurrent) → checkout starves              → bounded by busy=1
  R6 mem swallow rare → memory write lost silently                → contained (best-effort)
  R7 dim throw  config error → loud throw                         → CONTAINED (good!)
  R8 rejections  easy (any flow error) → UI permanently stuck    → CONTAINED (fixed)
```

The seam that matters: **single-device + human-paced** is the boundary that keeps R2–R5 dormant. Cross it (unattended, concurrent, or programmatic driving) and the same flags become live. R1 and R8 no longer belong to that group — they were live *today*, human-paced or not, and both got fixed the same week they were found. R2 is now the single item most worth fixing next: it's the last unhandled hang in the interactive path.

---

## The ranked findings

### R1 — No SIGINT handler; Ctrl-C skipped clean shutdown · **FIXED** (was HIGH)

**Evidence (the bug, before Aug 2):** no `process.on('SIGINT'...)` anywhere; the only clean-shutdown path was `/exit` → `session.close()` → `pool.end()`, and `pool.end()` itself had no bound.
**Evidence (the fix, `64f822f` + `9c1b1e6`):** `forceExit()` (`src/cli/chat.tsx:464`) races `session.close()` against a hard, `.unref()`'d 1.5s timer; `session.close()` itself (`src/session.ts:876-881`) races `pool.end()` against a 1s timer. Two triggers call it: a keystroke handler inside `useKeyboard` (`chat.tsx:379-383`) — needed because `exitOnCtrlC: false` plus raw-mode stdin means the terminal never emits a real SIGINT for a Ctrl+C keystroke — and `process.on('SIGINT', forceExit)` (`chat.tsx:466`) for a signal sent from outside the terminal.
**What's left:** this is *bounded* shutdown, not fully graceful — the process is guaranteed to exit within 1.5s, but a trace write still `pending[]`-queued for an in-flight turn can be lost if the pool doesn't close in time. That's a strictly smaller exposure window than before (unbounded → ~1.5s), and it's a deliberate tradeoff, not an oversight — see `07` for why blocking until the drain finishes would reintroduce the exact hang this fix removed.
**Why this one is worth remembering:** it's a real incident-and-fix, not a hypothetical audit item — Ctrl-C actually hung the process before this landed, and the two-commit history (`64f822f` then `9c1b1e6`, minutes apart) shows the first attempt wasn't sufficient on its own (a plain `process.on('SIGINT')` does nothing when raw-mode stdin swallows the keystroke first). → `07`.

### R2 — No deadline or timeout on the model/DB/web calls · **HIGH — now the top remaining gap**

**Evidence:** `await agent.answer(q)` (`src/session.ts:675`) has no timeout; no `statement_timeout` set on the pool; no timeout option passed to Ollama from buffr. The connector tools (Brave/Tavily/Google/Reddit/RSS/Amazon) make external HTTP calls with no configured timeout at the call site.
**What breaks:** a wedged Ollama *or* a stalled web API call (Google CSE responding slowly, Tavily down) hangs the turn forever — the spinner and the `/research` progress panel both animate forever, `busy` stays `true`, the UI accepts no input. With R1 fixed, this is now the *only* remaining unhandled hang in the interactive path — the one place a user can still get stuck with no clean way out short of quitting the terminal.
**The surprising part:** the fix is mostly wiring, not new design. `RagQueryAgent.answer(question, { signal })` already accepts an `AbortSignal` (`packages/kernel/src/agents/rag-query-agent.ts:63`), and every layer beneath it — the tool loop, the embedder, the Gemma gateway's `fetch` — already checks `signal?.throwIfAborted()` and forwards the signal deeper. `session.ts:675` just never constructs one. `grep -rn "new AbortController" .` across the whole repo, tests included, returns nothing — the cancellation seam was built end-to-end and never connected to a trigger.
**The fix:** `Promise.race([agent.answer(q, { signal: ctrl.signal }), deadline(N).then(() => ctrl.abort())])` at `src/session.ts:675`. The existing `catch` in `handleSubmit` already renders an error gracefully, so the UI side needs no new code. → `07`.

### R3 — No cancellation trigger; a started turn can't be stopped · **MEDIUM**

**Evidence:** the `AbortSignal` parameter exists at every layer of `@buffr/kernel` and `@buffr/connectors` (see R2), but no `AbortController` is ever constructed anywhere in the repo, and the OpenTUI UI has no cancel key.
**What breaks:** once a turn starts, the user waits it out — no cancel key, no way to interrupt a long generation. Pure UX cost, no data risk, and distinct from R2: R2 is "nothing stops a hang," R3 is "nothing lets the *user* stop a turn they no longer want," even one that's progressing normally.
**The fix:** construct an `AbortController` in `chat.tsx`, bind it to a keypress in `useKeyboard` (the same layer that now catches Ctrl+C for R1), pass `{ signal: ctrl.signal }` into `agent.answer`. No kernel change required — R2's fix and this one share the same missing line at the call site. Lower priority than R2 because it degrades experience, not correctness. → `07`.

### R4 — `turns[]` grows unbounded for the session's life · **MEDIUM**

**Evidence:** append-only `setTurns((t) => [...t, ...])` throughout `handleSubmit` (`src/cli/chat.tsx`), no cap, freed only at `/exit`.
**What breaks:** a never-exiting or programmatically-driven session climbs in heap linearly (2+ entries/turn — more per turn now that `/research`/`/review` flows and progress-step arrays attach to some entries). At human scale (dozens of turns) it's nothing; the verdict is "right for the use case, wrong for unattended."
**The fix:** a max-length cap or message virtualization. Note it's *display-only* — it doesn't feed the model, so capping it is purely a memory decision. → `05`.

### R5 — Pool runs on defaults; no `max`, timeout, or idle tuning · **LOW (today)**

**Evidence:** `new pg.Pool({ connectionString })` only (`src/db.ts:4-5`) — default max 10, no `connectionTimeoutMillis`, no `idleTimeoutMillis`. Unchanged by the R1 fix: the shutdown timeout lives in `session.close()`'s wrapper around `pool.end()`, not in the pool's own construction options.
**What breaks:** under concurrent turns (which `busy=1` currently forbids), a checkout could block indefinitely with no timeout. Today the seriality bound makes this dormant — one turn never approaches 10 connections. `PgJournalStore` (`src/pg-journal-store.ts`) and `PgVectorStore` share this same undertuned pool, so the surface area grew slightly with the decision-journal feature, but the same `busy=1` bound still covers it.
**The fix:** set `connectionTimeoutMillis` and tune `max` *if* concurrency is ever introduced. Low now precisely because the `busy` flag bounds concurrency to one. → `06`, `07`.

### R6 — `memory.remember` failure is silently swallowed · **LOW**

**Evidence:** `try { await memory.remember(...) } catch { /* swallow */ }` in `session.ts`'s `ask()`.
**What breaks:** a failed episodic-memory write is dropped with no log — the turn succeeds and the user gets their answer, but that exchange won't resurface in future retrieval, and nothing records that it was lost.
**Why it's defensible:** the comment is explicit — memory is best-effort, the answer the user already has must not be lost to a memory-write error. **The nit:** swallow *silently* means a systematically-failing memory write is invisible. A one-line `console.warn` in the catch would make the failure observable without changing the best-effort contract. → cross-link `study-debugging-observability`.

### R7 — Dimension mismatch throws loudly · **GOOD FLAG (not a risk)**

**Evidence:** `assertDim` throws `dimension mismatch: got X, store is 768` on every `upsert`/`search` (`src/pg-vector-store.ts:32-36`).
**Why it's listed:** this is the *right* runtime behavior — fail loud and early on a config error (wrong embedding model) rather than silently truncate or write garbage vectors. It's the model for how R6 *should* behave. Called out as the positive control: the repo knows how to fail loud when it chooses to.

### R8 — Unhandled rejections in the interactive flows left the UI permanently stuck · **FIXED**

**Evidence (the bug):** when `research-flow.ts`/`review-flow.ts` were first wired into `chat.tsx` (`1344d9b`), the three new async call sites — the active-flow interceptor, `/research`'s `controller.start()`, `/review`'s `controller.start()` — used one-argument `.then(result => ...)` with no rejection handler. A thrown error inside a flow's `start()`/`submit()` (a DB error from `journalStore.create`, a thrown parse failure) became an **unhandled promise rejection**: nothing caught it, `busy` stayed `true` forever, and the input box — which is conditionally hidden while `busy` — never came back. The only recovery was killing the process.
**Evidence (the fix, `26f0e4b`):** every `.then(success)` became `.then(success, error)`, mirroring the two-arg style already used by `/investing`, `/eval`, and the plain-`/ask` path elsewhere in the same file. The error handler resets `busy` and clears `activeFlow`, so a DB error now surfaces as a normal `error: ...` turn instead of a frozen UI.
**Why this belongs in the runtime-systems guide, not just a changelog:** it's a textbook instance of the event-loop hazard this guide's `03` file teaches — a rejected Promise with no `.catch`/no second `.then` argument doesn't crash a Node process outright (no `unhandledRejection` crash policy is configured here), it just orphans whatever state was waiting on it. In a UI gated by a `busy` flag, an unhandled rejection and a missing `finally` produce the identical symptom: permanently stuck input. The fix is the same discipline as the `try/finally` pattern taught in `06` — every code path that sets `busy = true` needs a matching path that clears it, success or failure. → `03`.

---

## Primary diagram

The ranked audit in one frame — two items fixed, R2 now the clear top gap.

```
  Runtime red-flags — ranked verdict

  FIXED ─────►  HIGH ────────────────────────────────────► MEDIUM ──► LOW
  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────┐ ┌─────────┐ ┌────────┐ ┌────────┐
  │R1 SIGINT │ │R8 unhndl │ │R2 timeout│ │R3 cancel│ │R4 turns[]│ │R5 pool │ │R6 mem  │
  │ bounded  │ │ rejection│ │ hangs ∞  │ │ no      │ │ unbounded│ │defaults│ │ swallow│
  │ shutdown │ │ UI stuck │ │ on wedge │ │ trigger │ │ growth   │ │(busy=1 │ │ silent │
  │ (fixed)  │ │ (fixed)  │ │ signal   │ │ for the │ │ /exit    │ │ saves) │ │        │
  │          │ │          │ │ unused   │ │ AbortSig│ │ frees    │ │        │ │        │
  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬────┘ └────┬─────┘ └───┬────┘ └───┬────┘
       │            │            │            │           │           │          │
   chat.tsx:464  chat.tsx    session.ts   (never       chat.tsx    src/db.ts  session.ts
   session.ts:876  :166-190  :675          constructed) handleSubmit :4-5      ask()
  ┌─────────────────────────────────────────────────────────────────────┐
  │ R7 dimension mismatch THROWS — the positive control: fail loud, good │
  │    src/pg-vector-store.ts:32-36                                       │
  └─────────────────────────────────────────────────────────────────────┘
  Dormant-keeper seam (R3-R5): single-device + human-paced + busy=1
  R1 and R8 were live regardless of scale — both hit and fixed the same week.
```

---

## Elaborate

The last pass of this audit found five deliberate omissions and one throw-loud positive control. Two of those omissions — R1 and R8 — turned out not to be dormant at all: they were live bugs that a human hit while actually using the tool, both fixed within the same week, both leaving a clean before/after in the git history. That's the most useful thing this audit can show: not "here's a list of theoretical gaps" but "here's what an omission looks like the day it stops being theoretical, and here's what the fix looked like." Both fixes share a shape worth naming — R1's `forceExit()` and R8's two-arg `.then(success, error)` are both instances of the same rule: **every path that starts something (`busy = true`, a shutdown) needs a matching path that ends it, on every branch, including the error branch.** R1 forgot the shutdown path could hang; R8 forgot the error branch could fire.

What's left is a shorter, more honest list. R2 is now unambiguously the top item — not just "no timeout" but "no timeout, on the one call in the interactive path that can still hang the process indefinitely," made sharper by R1's fix removing the other hang. R3 is the same missing piece as R2's fix, viewed from the UX side rather than the correctness side — worth doing in the same pass, since it's the same `AbortController` doing double duty. R4, R5, R6 are unchanged: still deliberate, still scale-gated, still worth naming rather than fixing today.

If you do exactly two things next: wire an `AbortSignal` into `agent.answer` at `session.ts:675` with a deadline (R2), and reuse that same controller for a cancel keypress (R3). That's one piece of new code — an `AbortController` constructed in `chat.tsx` — doing the work of both remaining HIGH/MEDIUM items, because the kernel-side plumbing for both already exists.

---

## Interview defense

**Q: "If I had to harden this repo's runtime, what would you fix first and why?"**

> Two of the things I'd have said six months ago are already done — Ctrl-C used to hang the process with no SIGINT handler, and there was a class of unhandled-promise-rejection bug in the new interactive flows that left the input permanently stuck on any DB error. Both got fixed the same week they were hit, and both fixes share a pattern: make sure every path that starts something has a matching path that ends it, including the error path. What's left, and what I'd do next, is a per-turn deadline on `agent.answer` — it's the last unhandled hang in the interactive path, and the interesting part is that the fix is nearly free: the kernel already accepts an `AbortSignal` at every layer down to the fetch call, `session.ts` just never constructs one. I'd build that `AbortController` once and reuse it for a cancel keypress too, since that's the same missing piece from the UX side. I'd leave the `turns[]` cap and pool tuning for when concurrency or long sessions actually arrive — those are genuinely scale-gated, and the `busy` flag keeps concurrency at one for now.

```
  fix order — leverage ÷ cost

  DONE:  SIGINT / bounded shutdown           [R1]  — fixed 64f822f, 9c1b1e6
  DONE:  unhandled rejections in flows       [R8]  — fixed 26f0e4b
  NEXT:  1. AbortController + deadline on agent.answer      [R2]
         2. same AbortController wired to a cancel key      [R3]
         3. console.warn in the memory catch (1 line)       [R6]
  ── then, when scale changes: R4 turns[] cap, R5 pool tuning ──
```

**Anchor:** "The two highest-severity items from the last audit are fixed — `forceExit()` at `chat.tsx:464` bounds Ctrl-C to a 1.5s exit, and `26f0e4b` added the missing rejection handlers to the research/review flows. What's left is R2: `agent.answer` at `session.ts:675` takes no signal and no deadline, even though the kernel already accepts one three layers down — that's the top remaining fix, and it's mostly wiring."

---

## See also

- `00-overview.md` — the same findings as the top-level summary
- `07-backpressure-bounded-work-and-cancellation.md` — R1/R2/R3 in depth, including the AbortSignal seam
- `03-event-loop-and-async-io.md` — R8, the unhandled-rejection hazard in the interactive flows
- `05-memory-stack-heap-gc-and-lifetimes.md` — R4, the unbounded `turns[]`
- `06-filesystem-streams-and-resource-lifecycle.md` — R5, the pool's lifecycle and defaults
- `study-debugging-observability` — where R6's silent swallow belongs (logging the dropped memory write)
