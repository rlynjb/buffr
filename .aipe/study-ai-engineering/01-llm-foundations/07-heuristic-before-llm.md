# Heuristic Before LLM

*Cheap-path routing / pre-LLM gating — Project-specific pattern (not yet exercised).*

## Zoom out, then zoom in

The model is the most expensive box in buffr — slowest on a laptop, most tokens, most non-determinism (`06-token-economics.md`). The cheapest engineering win is often *not calling it*: handle the trivial cases with a deterministic check first. buffr does **not** do this — every question, however trivial, runs the full agent loop. Here's the path that exists, and the gate that doesn't.

```
  Zoom out — where a pre-LLM gate WOULD sit in buffr

  ┌─ TUI layer (Ink) ───────────────────────────────────┐
  │  chat.tsx → session.ask(question)                    │
  └──────────────────────────┬───────────────────────────┘
                             │  every question, unconditionally
  ┌─ Session layer (buffr) ──▼───────────────────────────┐
  │  ★ no gate here ★ ── would route cheap cases out     │ ← the missing fast-path
  │  ask(): persistMessage → agent.answer → memory       │
  └──────────────────────────┬───────────────────────────┘
                             │  ALWAYS hits the loop
  ┌─ Agent layer (aptkit) ───▼───────────────────────────┐
  │  RagQueryAgent.answer → runAgentLoop (model + tools) │
  └──────────────────────────────────────────────────────┘
```

Zoom in: a heuristic-before-LLM is a router with two exits — a cheap deterministic exit for inputs you can answer (or reject) without the model, and the expensive LLM exit for everything else. The pattern is just an `if` that runs *before* the costly call. buffr has no such `if`: `session.ask` goes straight to `agent.answer` for `"hi"`, `""`-ish junk, and a real question alike. This file is honest about that gap and gives a concrete Case-B.

## Structure pass

Trace the axis **who decides the answer for this input — code or the model?** across where the gate would split.

```
  Axis: "who decides this input's answer?" — with vs without the gate

  WITHOUT gate (buffr today)        WITH gate (the pattern)
  ┌─ session.ask ──────────┐        ┌─ session.ask ──────────────┐
  │ everything → model     │        │ cheap check first:         │
  │ control = MODEL always │        │   match? → CODE decides    │ ← control flips
  └────────────┬───────────┘        │   else  → MODEL decides    │
               ▼                     └────────────┬───────────────┘
        runAgentLoop                              ▼
                                          gate is the seam
```

The seam is the gate itself, and the axis flips *across it*: above the gate, code can decide (return a canned reply, reject empty input, skip retrieval); below it, the model decides. buffr's seam is currently a no-op — control never flips to code because there's no gate, so the model decides everything, including the cases code could have handled for free. That permanent "model decides" is the inefficiency this pattern fixes.

## How it works

#### Move 1 — the mental model

You know how you guard a `fetch()` with an early return — `if (!query.trim()) return;` — so you don't fire a network request for empty input? A heuristic-before-LLM is that early return, scaled to "don't fire the *model* for inputs a cheap rule can settle." The strategy: **try the cheap deterministic path first; fall through to the model only when the cheap path can't answer.**

```
  Pattern — the two-exit router (a guard clause before the costly call)

  input ──► ┌─ cheap heuristic ─────────────┐
            │  empty / greeting / regex hit? │
            └───────┬───────────────┬─────────┘
                yes │           no  │
                    ▼               ▼
            return canned /   runAgentLoop (model + retrieval)
            reject early      ← the expensive path
            (NO model call)
```

The whole pattern is the top diamond. Everything below it is the existing buffr path; the gate just decides whether you ever get there.

#### Move 2 — the step-by-step walkthrough

**The unconditional entry point.** buffr's `session.ask` runs the same three steps for every input — persist, run the agent, remember — with no branch on what the input is.

```
  ChatSession.ask — src/session.ts:60-71 (annotated)

  async ask(question: string): Promise<string> {
    await persistMessage(pool, conversationId, 'user', question);   // always
    const answer = await agent.answer(question);                    // ← always hits the loop
    await trace.flush();
    try { await memory.remember({ conversationId, question, answer }); } catch {}
    return answer;
  }
```

There's no `if` before `agent.answer`. `"hi"`, a one-word typo, or a genuine question all take the identical, expensive route. That's the gap: the cheapest possible inputs pay the full model cost.

**Where the loop confirms it always runs the model.** Even inside the agent, the system template *forces* a retrieval-then-answer flow — there's no early exit for trivial input.

```
  RagQueryAgent system template — rag-query-agent.ts:20-27 (annotated)

  'You are a personal knowledge assistant.',
  `Always call the ${SEARCH_KNOWLEDGE_BASE_TOOL_NAME} tool first ...`,  // ← ALWAYS retrieve
  '... Ground every answer in the retrieved chunks ...',
```

"Always call the tool first" means even `"hi"` triggers an embedding + a pgvector search + a synthesis call. The model decides everything because the prompt tells it to, and nothing upstream intercepts. (Note: this template lives in aptkit and buffr passes its own `profile` but not a custom `prompt` — so the gate belongs in buffr's `ask`, before the agent, not inside aptkit.)

**Where the gate would go — buffr-side, before `agent.answer`.** The clean insertion point is a guard clause in `ask`, returning before the costly call when a cheap rule fires.

```
  Layers-and-hops — the gate buffr could add (Case B), all buffr-side

  ┌─ session.ask (buffr) ───────────────────────────────────────────┐
  │  const q = question.trim();                                     │
  │  if (q === '') return 'Ask me something about your notes.';     │ ← exit 1: reject
  │  if (/^(hi|hello|hey)\b/i.test(q)) return 'Hi! What ...?';      │ ← exit 2: canned
  │  // else fall through:                                          │
  │  const answer = await agent.answer(q);  ← model only NOW        │ ← exit 3: expensive
  └─────────────────────────────────────────────────────────────────┘
   exits 1 & 2 skip: embedding call + pgvector search + synthesis call
```

Exits 1 and 2 save a full model round-trip plus a retrieval — the most expensive operations in the system — for inputs that never needed them. This is entirely buffr-side; aptkit is untouched.

#### Move 2.5 — current state vs future state

Built-but-absent: the entry point exists, the gate doesn't.

```
  Phase A (now) vs Phase B (Case B) — input routing

  Phase A — NO GATE                 Phase B — CHEAP PATH FIRST
  ┌──────────────────────────┐      ┌──────────────────────────────┐
  │ ask → agent.answer always│      │ ask → guard clause:          │
  │ "hi" costs a full loop   │  ──► │   trivial → canned/reject    │
  │                          │      │   real    → agent.answer     │
  └──────────────────────────┘      └──────────────────────────────┘
  must change: a few lines in session.ask. What does NOT change:
  the agent, retrieval, aptkit, the ledger.
```

The cost is a few lines and a judgment call about which heuristics are *safe* (false positives that wrongly skip the model are the risk). That risk is why the kernel below matters.

#### Move 2 variant — the load-bearing skeleton

The pattern has a tiny kernel; name each part by what breaks without it.

```
  Kernel — pre-LLM gate

  1. a CHEAP predicate     — drop it → no way to identify the trivial case
  2. a SAFE default exit   — drop it → false positive wrongly skips a real question
  3. FALL-THROUGH to model — drop it → you've replaced the LLM, not gated it

  hardening (optional): metrics on hit-rate, a confidence threshold,
  multiple heuristics tried in order.
```

The load-bearing, easily-forgotten part is **part 3, the fall-through**: a gate that doesn't fall through to the model is no longer a gate — it's a brittle rules engine that fails on anything unanticipated. The skill is making the predicate *conservative*: only fire on cases you're certain about, fall through on doubt.

#### Move 3 — the principle

The cheapest LLM call is the one you don't make. Route the inputs a deterministic rule can settle — empty input, greetings, exact-match commands — out *before* the model, and reserve the expensive, non-deterministic path for genuine questions. The discipline is conservatism: only short-circuit when you're sure, always fall through on doubt. buffr pays full price for every "hi" today; a few lines of guard clause in `session.ask` would fix it without touching the agent.

## Primary diagram

```
  Heuristic-before-LLM — the gate buffr lacks, where it belongs

  input (question)
        │
  ┌─ session.ask [src/session.ts:60] ─────────────────────────────┐
  │  ┌─ GATE (Case B — not present today) ─────────────────────┐  │
  │  │  empty?     → reject (no model)                         │  │  exit 1
  │  │  greeting?  → canned reply (no model)                   │  │  exit 2
  │  │  else ───────────────────────────────────────────────┐ │  │
  │  └──────────────────────────────────────────────────────│─┘  │
  │  await agent.answer(q)  ◄── ALWAYS reached today ────────┘    │  exit 3
  └───────────────────────────────┬────────────────────────────────┘
                                  ▼
  runAgentLoop → embed → pgvector search → gemma2:9b synthesis
  (the expensive path; exits 1&2 would skip ALL of this)
```

## Elaborate

"Heuristic before LLM" is one instance of a general systems rule: put the cheap, certain, deterministic work before the expensive, uncertain, probabilistic work. The same shape shows up as cache-before-compute, validate-before-process, and rate-limit-before-handle. For LLM apps specifically it matters more because the expensive path isn't just slow — it's *non-deterministic* and *unbounded in cost*, so every call you avoid is a call that can't hallucinate, can't run up tokens, and can't make the user wait on a 9B model.

The tension to respect: heuristics are brittle by nature, and an over-eager gate that wrongly short-circuits a real question is worse than no gate. That's why the conservative-predicate + always-fall-through skeleton is the load-bearing part. Connections: this is the input-side sibling of `06-production-serving/`'s caching (output-side cheap path), and it composes with `04-agents-and-tool-use/04-routing` (a richer router that picks *which* expensive path, where this one picks *whether* to take any).

## Project exercises

No curriculum file present; exercises derived from the codebase. This concept is **not yet exercised** — Case B (a fast-path / skip-retrieval gate).

### EX-07-1 — Add a conservative pre-LLM guard clause

- **Exercise ID:** EX-07-1
- **What to build:** A guard clause at the top of `session.ask` that handles empty/whitespace input (reject with a prompt) and a small set of greetings (canned reply) *without* calling `agent.answer`, then falls through to the agent for everything else.
- **Why it earns its place:** Eliminates the most wasteful calls (a full loop for `"hi"`) in a few lines, entirely buffr-side; demonstrates the cheap-path-first discipline.
- **Files to touch:** `src/session.ts:60-71` (the `ask` method). Do not edit aptkit.
- **Done when:** `"hi"` and `""` return without any model or pgvector call (verifiable via the trace: no `model_usage` row), while real questions still run the loop.
- **Estimated effort:** 1-4hr

### EX-07-2 — Measure the gate's hit rate

- **Exercise ID:** EX-07-2
- **What to build:** Emit a trace/log when the gate short-circuits, then a script that reports what fraction of inputs were handled cheaply — turning the optimization into a measured one and guarding against over-eager false positives.
- **Why it earns its place:** A gate without a hit-rate metric can silently hurt (wrongly skipping real questions); measurement is what makes it safe to keep.
- **Files to touch:** the guard from EX-07-1; `src/supabase-trace-sink.ts` (reuse the `warning`/event path) or a simple log; a new `scripts/gate-hit-rate.ts`.
- **Done when:** you can report cheap-path hit rate and confirm no real questions were short-circuited.
- **Estimated effort:** 1-4hr

## Interview defense

**Q: "Does buffr do anything cheaper than the LLM for trivial inputs?"**

No — `session.ask` calls `agent.answer` unconditionally, and the agent's prompt says "always call the search tool first," so even `"hi"` triggers an embedding, a pgvector search, and a synthesis call. There's no pre-LLM gate; the cheapest fix is a guard clause in `ask`.

```
  buffr today: "hi" ──► full loop (embed + search + model)
  the fix:     "hi" ──► canned reply (no model)
```

*Anchor:* unconditional `agent.answer(question)` at `src/session.ts:62`; "always call the tool" at `rag-query-agent.ts:23`.

**Q: "What's the risk of adding heuristic short-circuits?"**

False positives — a too-eager rule that wrongly skips the model for a real question. The load-bearing safeguard is the *fall-through*: only short-circuit on cases you're certain about, fall through to the model on any doubt, and measure the hit rate to catch mistakes.

```
  conservative predicate + always fall through

  sure it's trivial?  yes → canned     no → model (NEVER guess)
```

*Anchor:* the gate belongs before `agent.answer` at `src/session.ts:62`, with the model as the default exit.

## See also

- `06-token-economics.md` — the expensive path this gate avoids (latency is the local budget).
- `08-provider-abstraction.md` — the provider behind the expensive exit.
- `../04-agents-and-tool-use/01-agents-vs-chains.md` — the loop the gate routes around.
- `../06-production-serving/` — caching, the output-side cheap path.
