# Heuristic Before LLM

*Industry name: pre-LLM routing / cheap-path short-circuit / classifier gate. Type: **Language-agnostic** pattern.*

## Zoom out, then zoom in

The cheapest LLM call is the one you don't make. *Heuristic-before-LLM* is a cheap test that runs *first* and decides whether the expensive model call is even needed. Here's where it would sit in buffr — and the honest truth is the slot is empty.

```
buffr stack — the missing cheap gate
┌───────────────────────────────────────────────────────────┐
│ chat.tsx   user types a turn                                │
├───────────────────────────────────────────────────────────┤
│ ★ session.ask()   ← WHERE A HEURISTIC GATE WOULD GO         │ no gate today
├───────────────────────────────────────────────────────────┤
│ RagQueryAgent.answer()   "Always call search first"         │ always pays
├───────────────────────────────────────────────────────────┤
│ retrieval (embed → pgvector) + GemmaModelProvider           │ embed + generate, every turn
└───────────────────────────────────────────────────────────┘
```

Every turn — even `"hi"` or `"thanks"` — runs the full pipeline: embed the query, hit pgvector, build a prompt, call `gemma2:9b`. The system prompt literally says *"Always call the search_knowledge_base tool first."* **This is Case B: not implemented.** There is no cheap path. This file teaches the pattern and makes the gate the exercise.

## Structure pass — trace *cost-per-turn* across input types

Pick one axis: **what does a turn cost, by how trivial it is?** Trace it and watch buffr charge full price for everything.

```
cost per turn, by triviality (buffr today)
  "hi"                    │ embed + pgvector + LLM │ FULL price  ← overpaid
  "thanks"                │ embed + pgvector + LLM │ FULL price  ← overpaid
  "what's my deploy cmd?" │ embed + pgvector + LLM │ FULL price  ← justified
  ───────────────────────────────────────────────────────────────────────
  no seam: every input takes the same expensive path
```

There's no seam — that's the problem. A good system has a fork right at the top: trivial inputs peel off to a cheap canned response; substantive ones go to the LLM. Buffr has one road for all traffic. The consequence is concrete: greetings and acknowledgments each trigger an embedding call *and* a 9B-model generation, for an answer that didn't need either.

## How it works

### Move 1 — the mental model: a guard clause before the expensive work

You write these constantly in frontend: `if (!query.trim()) return;` before firing a fetch. Heuristic-before-LLM is that guard clause, scaled up: a cheap, deterministic test (regex, length, keyword, a tiny classifier) that handles the easy cases *without* the model, and only falls through to the LLM when the cheap test can't.

```
the guard-clause shape
  input
    │
  cheap test (regex/length/keyword)
    ├── matches "trivial" ──▶ canned/cheap response   ← no embed, no LLM
    └── falls through ──────▶ full RAG + LLM pipeline  ← pay only when needed
```

### Move 2 — the moving parts

#### Bridge: it's the `if (!q) return;` you already have, but smarter

`chat.tsx` already has the dumb version (`chat.tsx:23`: `if (!q) return;` for empty input). The pattern extends that: instead of just rejecting empty input, *classify* the input and route it. The natural home is `session.ask()` — before it persists the turn and calls the agent.

Here's `session.ask()` today, with the gap marked (`src/session.ts:60–71`):

```ts
async ask(question: string): Promise<string> {
  // ◀── A HEURISTIC GATE WOULD GO HERE:
  //     if (isTrivial(question)) return cannedReply(question);  ← skip everything below
  await persistMessage(pool, conversationId, 'user', question);
  const answer = await agent.answer(question);   // ← always embeds + calls gemma2:9b
  await trace.flush();
  try { await memory.remember({ conversationId, question, answer }); } catch {}
  return answer;
}
```

Annotation that matters: every line after the proposed gate is the expensive part — `agent.answer()` runs retrieval (an embedding call to Ollama + a pgvector query) and a generation call. A trivial input pays all of it for nothing.

#### The agent reinforces "always pay"

Even if you wanted the agent to skip retrieval, it won't — its system template hard-codes it (`rag-query-agent.ts:20–27`):

```ts
const DEFAULT_SYSTEM_TEMPLATE = [
  'You are a personal knowledge assistant.', '',
  `Always call the ${SEARCH_KNOWLEDGE_BASE_TOOL_NAME} tool first to retrieve relevant`,
  'passages before answering. ...',
].join('\n');
```

So the cheap path *cannot* live inside the agent — the agent's instructions forbid skipping retrieval. It has to live *above* the agent, in `session.ask()`. That placement is the key design call.

```
where the gate must live
  session.ask()      ← gate HERE (above the agent) ✓ can short-circuit
  RagQueryAgent      ← gate can't live here; "always search" is its contract ✗
```

### Move 2.5 — current vs future state

**Current:** no gate. Greetings, thanks, and one-word inputs all run embed + pgvector + `gemma2:9b`.

**Future (the exercise):** add `isTrivial(question)` in `session.ask()` — a regex/length test for greetings, acknowledgments, and empty-ish input — returning a canned reply that skips retrieval and generation entirely. Conservative on purpose: when in doubt, fall through to the LLM. A false "trivial" (skipping a real question) is far worse than a false "substantive" (paying for a greeting).

```
current → future
  CURRENT │ every turn → embed + pgvector + LLM
  FUTURE  │ isTrivial? ──yes──▶ canned reply (0 cost)
          │           └─no───▶ embed + pgvector + LLM
  bias: when unsure, DON'T skip — pay rather than mishandle a real question
```

### Move 3 — the principle that generalizes

> **Pay for intelligence only when intelligence is needed. A deterministic test handles the trivial tail for free; reserve the model for inputs that actually need it — and bias the test toward over-paying, because misrouting a real question is the expensive mistake.**

The asymmetry is the whole design. The cost of mis-skipping (a real question gets a canned "hi there!") is a broken product. The cost of mis-paying (a greeting runs the full pipeline) is a few wasted milliseconds and tokens. So the heuristic must be tight — only the unambiguous trivial cases — and everything else falls through to the model. Cheap-path routing is an optimization, never a correctness gamble.

## Primary diagram

The gate buffr is missing, and the asymmetry that shapes it.

```
heuristic-before-LLM (the slot in session.ask())
  question
     │
  ┌──────────── isTrivial(question)? ────────────┐   ← MISSING in buffr today
  │ regex: greetings, thanks, len<3, empty-ish    │
  └───────────────────┬───────────────────────────┘
        trivial │                 │ not trivial / unsure
                ▼                 ▼
        canned reply        agent.answer()  → embed + pgvector + gemma2:9b
        (0 embed, 0 LLM)    (full price)
  ───────────────────────────────────────────────────────────────────────
  asymmetry: mis-skip a real Q = broken product (bad)
             mis-pay for "hi"   = a few wasted ms (fine)
  ∴ keep the trivial set TINY; fall through when unsure
```

## Elaborate

- **Origin.** The pattern predates LLMs — it's the cache/fast-path idea from systems work (check the cheap thing first). In LLM apps it shows up as intent classifiers, regex guards, and small-model routers in front of the expensive model. The modern framing is the "model cascade": cheap model/heuristic first, escalate only on miss.
- **Adjacent concepts.** *Token economics* (06) — this is the most aggressive economy, spending zero tokens. *Routing* (sub-section 04) — the agentic cousin, where a model picks the path. *Caching* (sub-section 06) — same spirit, different mechanism (remember past answers vs short-circuit trivial ones).
- **Honest gap.** **Not implemented at all** — there's no classifier, no regex gate, no length check beyond the empty-string guard. And the agent's "always search" contract means the gate can't live in the agent; it has to be added above it in `session.ask()`.
- **What to read next.** File 08 — provider abstraction, the seam that makes *all* these swaps (including a cheap-model router) a constructor change.

## Project exercises

### Add a triviality gate to session.ask()

- **Exercise ID:** [B1.13] (Phase 1 — LLM foundations) — **Not yet implemented** (Case B; no cheap path exists).
- **What to build:** An `isTrivial(question)` helper (regex for greetings/thanks, length threshold, empty-ish) and a small canned-response map, wired into the top of `session.ask()` so trivial inputs return immediately without embedding or calling `gemma2:9b`. Bias it conservative: only unambiguous cases short-circuit.
- **Why it earns its place:** It's the first place buffr stops paying for intelligence it doesn't need, and it teaches the mis-skip/mis-pay asymmetry hands-on.
- **Files to touch:** new `src/triviality.ts`; `src/session.ts:60` (gate at the top of `ask()`). Note it must live here, not in the agent (the agent's "always search" prompt forbids skipping).
- **Done when:** `"hi"` and `"thanks"` return a canned reply with no `model_usage` row written, while a real question still runs the full pipeline.
- **Estimated effort:** 1–4hr

### Measure the trivial-traffic share

- **Exercise ID:** [B1.14] (Phase 1 — LLM foundations)
- **What to build:** Log how many turns `isTrivial` would catch over a real session, to size the savings before committing to the gate.
- **Why it earns its place:** Justifies the optimization with data — if 0% of traffic is trivial, the gate isn't worth the misroute risk.
- **Files to touch:** instrumentation in `src/session.ts`; depends on [B1.13]'s `isTrivial`.
- **Done when:** a session report prints the fraction of turns classified trivial and the tokens those turns would have spent.
- **Estimated effort:** <1hr

## Interview defense

**Q: "Buffr calls the LLM on every turn, including 'hi'. How would you fix that, and what's the risk?"**

Model answer: Add a heuristic gate in `session.ask()`, above the agent — a regex/length test that catches unambiguous trivial inputs (greetings, thanks) and returns a canned reply, skipping both the embedding call and the `gemma2:9b` generation. It has to live above the agent because the agent's system prompt hard-codes "always call search first," so the agent can't be the one to skip. The risk is the asymmetry: mis-skipping a real question gives the user a broken canned reply, which is far worse than mis-paying for a greeting. So I keep the trivial set tiny and fall through to the LLM whenever unsure — it's an optimization, never a correctness gamble.

```
the fix and its risk
  gate in session.ask() (above agent) → isTrivial? → canned | full pipeline
  risk: mis-skip real Q = broken UX  >>  mis-pay "hi" = wasted ms
  ∴ tiny trivial set, fall through when unsure
```

Anchor: *Cheap gate above the agent; bias toward paying, because misroute is the expensive error.*

## See also

- `06-token-economics.md` — the cost this gate avoids paying.
- `08-provider-abstraction.md` — the seam that makes a cheap-model router a one-line swap.
- `../04-agents-and-tool-use/` — routing, the agentic version of this gate.
