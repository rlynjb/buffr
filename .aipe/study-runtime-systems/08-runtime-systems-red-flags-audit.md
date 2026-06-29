# Runtime Systems — Red-Flags Audit

**Industry name(s):** execution-model risk audit, ranked-by-consequence verdict · *Project-specific (the verdict file)*

---

## Zoom out, then zoom in

This is the verdict file. Every runtime risk in `buffr-laptop`, ranked by what actually breaks and grounded in a `file:line`. The honest top line: **most "red flags" here are deliberate single-device tradeoffs, not bugs** — but they're the exact list that flips from "fine" to "incident" the moment buffr runs unattended or under concurrent load. Read this as the change-list for that day.

```
  Zoom out — risk surfaces across the runtime

  ┌─ Interface ──────────────────────────────────────────────┐
  │  R3 no cancel key   ·  R1 no SIGINT (clean exit only /exit)│
  └──────────────────────────┬───────────────────────────────┘
  ┌─ Runtime ────────────────▼───────────────────────────────┐
  │  R2 no deadline/timeout  ·  R4 turns[] unbounded          │
  │  R6 memory.remember best-effort (silent swallow)          │
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

  R1 SIGINT     easy (Ctrl-C) → pool not drained, flush lost → NOT contained
  R2 timeout    medium (wedge) → turn hangs ∞               → NOT contained
  R3 cancel     UX (mind change) → wait it out              → NOT contained
  R4 turns[]    slow (long session) → heap climbs           → contained by /exit
  R5 pool       load (concurrent) → checkout starves        → bounded by busy=1
  R6 mem swallow rare → memory write lost silently          → contained (best-effort)
  R7 dim throw  config error → loud throw                   → CONTAINED (good!)
```

The seam that matters: **single-device + human-paced** is the boundary that keeps R1–R5 dormant. Cross it (unattended, concurrent, or programmatic driving) and the same flags become live.

---

## The ranked findings

### R1 — No SIGINT/SIGTERM handler; Ctrl-C skips clean shutdown · **HIGH**

**Evidence:** No `process.on('SIGINT'...)` anywhere. The only clean-shutdown path is `/exit` → `session.close()` → `pool.end()` (`src/cli/chat.tsx:18-21`, `src/session.ts:72-74`).
**What breaks:** Ctrl-C on the chat process kills it without draining the pool or flushing in-flight trace writes. A turn interrupted mid-`flush` (`src/session.ts:63`) loses its queued `agents.messages` rows.
**Why it's still defensible:** single-device, human-driven; the OS reclaims sockets and a lost trace row is harmless. **The verdict:** the cheapest, highest-value fix — three lines wiring SIGINT to `session.close()`. The first thing to add if buffr ever runs unattended. → `07`.

### R2 — No deadline or timeout on the model/DB calls · **HIGH**

**Evidence:** `await agent.answer(q)` (`src/session.ts:62`) has no timeout; no `statement_timeout` set on the pool; no timeout option passed to Ollama from buffr.
**What breaks:** a wedged Ollama (model loading, GPU contention, hung socket) or a slow pg query hangs the turn forever — the spinner spins, `busy` stays `true`, the UI accepts no input until the process is killed (which then hits R1).
**The fix:** `Promise.race([agent.answer(q), timeout(N)])`; the existing `catch` in `onSubmit` (`src/cli/chat.tsx:30-32`) already renders an error gracefully, so the wiring is small. → `07`.

### R3 — No cancellation; a started turn can't be stopped · **MEDIUM**

**Evidence:** no `AbortController`/`AbortSignal` in the repo; `agent.answer` takes no signal.
**What breaks:** once a turn starts, the user waits it out — no cancel key, no way to interrupt a long generation. Pure UX cost, no data risk.
**The fix:** thread an `AbortSignal` from a keypress through `agent.answer`. Lower priority than R1/R2 because it degrades experience, not correctness. → `07`.

### R4 — `turns[]` grows unbounded for the session's life · **MEDIUM**

**Evidence:** append-only `setTurns((t) => [...t, ...])` (`src/cli/chat.tsx:25,29`), no cap, freed only at `/exit`.
**What breaks:** a never-exiting or programmatically-driven session climbs in heap linearly (2 entries/turn). At human scale (dozens of turns) it's nothing; the verdict is "right for the use case, wrong for unattended."
**The fix:** a max-length cap or message virtualization. Note it's *display-only* — it doesn't feed the model (`src/session.ts:24-27`), so capping it is purely a memory decision. → `05`.

### R5 — Pool runs on defaults; no `max`, timeout, or idle tuning · **LOW (today)**

**Evidence:** `new pg.Pool({ connectionString })` only (`src/db.ts:4`) — default max 10, no `connectionTimeoutMillis`, no `idleTimeoutMillis`.
**What breaks:** under concurrent turns (which `busy=1` currently forbids), a checkout could block indefinitely with no timeout. Today the seriality bound makes this dormant — one turn never approaches 10 connections.
**The fix:** set `connectionTimeoutMillis` and tune `max` *if* concurrency is ever introduced. Low now precisely because the `busy` flag bounds concurrency to one. → `06`, `07`.

### R6 — `memory.remember` failure is silently swallowed · **LOW**

**Evidence:** `try { await memory.remember(...) } catch { /* swallow */ }` (`src/session.ts:64-69`).
**What breaks:** a failed episodic-memory write is dropped with no log — the turn succeeds and the user gets their answer, but that exchange won't resurface in future retrieval, and nothing records that it was lost.
**Why it's defensible:** the comment is explicit — memory is best-effort, the answer the user already has must not be lost to a memory-write error. **The nit:** swallow *silently* means a systematically-failing memory write is invisible. A one-line `console.warn` in the catch would make the failure observable without changing the best-effort contract. → cross-link `study-debugging-observability`.

### R7 — Dimension mismatch throws loudly · **GOOD FLAG (not a risk)**

**Evidence:** `assertDim` throws `dimension mismatch: got X, store is 768` on every `upsert`/`search` (`src/pg-vector-store.ts:32-36`).
**Why it's listed:** this is the *right* runtime behavior — fail loud and early on a config error (wrong embedding model) rather than silently truncate or write garbage vectors. It's the model for how R6 *should* behave. Called out as the positive control: the repo knows how to fail loud when it chooses to.

---

## Primary diagram

The ranked audit in one frame, severity left-to-right.

```
  Runtime red-flags — ranked verdict

  HIGH ─────────────────────────────────────────────────────────► LOW
  ┌──────────┐ ┌──────────┐ ┌─────────┐ ┌─────────┐ ┌────────┐ ┌────────┐
  │R1 SIGINT │ │R2 timeout│ │R3 cancel│ │R4 turns[]│ │R5 pool │ │R6 mem  │
  │ no clean │ │ hangs ∞  │ │ can't   │ │ unbounded│ │defaults│ │ swallow│
  │ shutdown │ │ on wedge │ │ stop    │ │ growth   │ │(busy=1 │ │ silent │
  │          │ │          │ │ turn    │ │ /exit    │ │ saves) │ │        │
  │          │ │          │ │ (UX)    │ │ frees    │ │        │ │        │
  └────┬─────┘ └────┬─────┘ └────┬────┘ └────┬─────┘ └───┬────┘ └───┬────┘
       │            │            │           │           │          │
   src/session  src/session  (absent)    chat.tsx     src/db.ts  session
   :72 / chat   :62                       :25,29       :4         :64-69
   :18-21
  ┌─────────────────────────────────────────────────────────────────────┐
  │ R7 dimension mismatch THROWS — the positive control: fail loud, good │
  │    src/pg-vector-store.ts:32-36                                       │
  └─────────────────────────────────────────────────────────────────────┘
  Dormant-keeper seam: single-device + human-paced + busy=1
```

---

## Elaborate

The pattern across R1–R5 is one decision repeated: buffr buys no insurance against failure modes a human operator catches by hand. That's coherent — it's a personal tool, and every omission has a clear "add it when X" trigger. The audit's value isn't "fix these now"; it's having the *list* so the additions are deliberate when the scale changes, not reactive after an incident. R6 and R7 are the contrast pair: R7 shows the repo failing loud where it matters (config error → throw), R6 shows it failing silent where it chose best-effort — and the one-line `console.warn` would make R6 observable without breaking its contract.

If you do exactly three things before unattended use: add the SIGINT handler (R1), add a per-turn deadline (R2), and add a `console.warn` to the memory catch (R6). That converts the three highest-leverage, lowest-cost items and leaves the genuinely scale-gated ones (R3, R4, R5) for when concurrency or long-running sessions actually arrive.

---

## Interview defense

**Q: "If I had to harden this repo's runtime, what would you fix first and why?"**

> SIGINT handling, first — three lines, and it's the difference between a clean drain and losing in-flight trace writes on Ctrl-C, because today the only clean exit is `/exit`. Second, a per-turn deadline with `Promise.race`, so a wedged Ollama call fails after N seconds instead of hanging forever — the UI's existing error-catch already renders it gracefully. Third, a `console.warn` in the memory-write catch, so a systematically-failing episodic write stops being invisible. I'd leave cancellation, the `turns[]` cap, and pool tuning for when concurrency or long sessions actually arrive — they're real but scale-gated, and the `busy` flag keeps concurrency at one for now.

```
  fix order — leverage ÷ cost

  1. SIGINT handler   (3 lines)  → clean shutdown, no lost flush   [R1]
  2. per-turn deadline(Promise.race) → no infinite hang            [R2]
  3. warn in mem catch(1 line)   → observable failure             [R6]
  ── then, when scale changes: R3 cancel, R4 cap, R5 pool tuning ──
```

**Anchor:** "Most flags here are deliberate single-device tradeoffs — the audit is the change-list for the day buffr runs unattended; R1 (SIGINT) is the top fix at `src/session.ts:72`, and R7 (dimension throw) is the positive control showing the repo fails loud where it counts."

---

## See also

- `00-overview.md` — the same findings as the top-level summary
- `07-backpressure-bounded-work-and-cancellation.md` — R1/R2/R3 in depth
- `05-memory-stack-heap-gc-and-lifetimes.md` — R4, the unbounded `turns[]`
- `06-filesystem-streams-and-resource-lifecycle.md` — R5, the pool's lifecycle and defaults
- `study-debugging-observability` — where R6's silent swallow belongs (logging the dropped memory write)
