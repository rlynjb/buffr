# buffr — Learning Roadmap

**Date:** 2026-07-08
**Status:** Roadmap — a learning-driven, eval-gated development plan
**Goal:** grow buffr into a personal AI CLI that gets smarter — where each capability added is a lens onto a component you want to master (the runtime agent loop, tools, retrieval, memory, evals), and **every change is proven by an eval, not vibes.**

---

## The thesis

You're not shipping features; you're **mastering the agent stack by improving it**, and measuring that the improvement is real. Same move every phase:

```
  pick a component  →  read its study guide + the aptkit source  →
  change it BY HAND  →  run an eval before/after  →  keep it only if the number moved
```

That loop — build, measure, keep-or-revert — is the AI-engineering skill this whole project is the portfolio case for.

---

## Foundational decision (confirm before Phase 2)

**Switch buffr's aptkit dependency from the published bundle to local `file:` paths.** You cannot "know and improve the runtime agent loop" through a frozen, read-only bundle in `node_modules`. You own the source (`/Users/rein/Public/aptkit`).

```
  TODAY (opaque)                     FOR LEARNING (editable)
  buffr → @rlynjb/aptkit-core@0.4.1   buffr → file:../aptkit/packages/*
    frozen in node_modules              you edit run-agent-loop.ts and
    the loop is a black box             see the change on next `npm run chat`
```

Reversible (it's just the consumption seam). This is the line between *using* aptkit and *being the person who improves it*. **Recommended.** Everything in Phase 2+ assumes this; keep the published bundle only if you want Phase 2 capped at "wrap, don't modify."

---

## How to run this — a loop, not a waterfall

The phases below are drawn as a line (0 → 5), but that arrow is a *priority / dependency* ordering, **not a sequence you march through**. The actual unit of work is an iteration, and there are two loops:

```
  INNER LOOP  (per change — minutes to hours)
    hypothesis → change it by hand → run the eval → did the number move?
        │                                              │
        │              keep it ◄──── yes    no ────► revert it
        └──────────────────────── repeat ──────────────────────┘

  OUTER LOOP  (per session — driven by what the eval says is weakest)
    eval report → "faithfulness is low" / "it misses multi-part questions" →
      pick the component that fixes THAT → may jump phases →
        back into the inner loop
```

What this means in practice:

- **The phases are a menu, not a railroad.** After Phase 0, the *eval* decides your order. If the number says retrieval is the bottleneck, you do Phase 4 before Phase 2. The list says *what* to improve and roughly *what depends on what* — not a fixed order.
- **You never "finish" a phase.** You run many small eval-gated changes; some you keep, most you revert. "Improve results" *is* this loop, run over and over.
- **Only two hard orderings exist:** Phase 0 comes first (no ruler → no iteration, just tinkering), and the aptkit-local-deps move comes before Phase 2 (can't edit the loop without the source). Everything else floats on priority.
- **This doc is a living plan.** As evals surface new weak spots and your goals shift, you revise it — same way you re-run the study materials. It's version 0 of a plan you keep editing, not a contract.

The eval is what turns this from open-ended tinkering into a real iterative process: it's the feedback signal that tells you whether the last iteration was progress or noise. Without it you're just changing things; with it, you're converging.

---

## The phases

```
  PHASE 0  MEASURE     build the eval harness FIRST (the ruler)
     ▼
  PHASE 1  FIX         close the known result-killers (small, high-leverage)
     ▼
  PHASE 2  THE LOOP    understand + improve run-agent-loop by hand   ← your core goal
     ▼
  PHASE 3  TOOLS       web search · DB-schema introspection
     ▼
  PHASE 4  RETRIEVAL   reranking · hybrid · query rewrite · chunking
     ▼
  PHASE 5  UX/SERVING  streaming · richer chat surface
```

### Phase 0 — Evals first (the ruler) · *"plug in evals"*
Build the measurement harness before improving anything, so every later change is scored.
- **Wire the `RubricJudge`** faithfulness eval (exists in aptkit, unwired today). Judge with **Claude/GPT, never Gemma** — don't grade the model with itself.
- **Grow the labeled set** — `eval/queries.json` is ~3 items; get to ~20–30 with known-relevant docs.
- **Add a tool-use eval** — did it call the right tool, with the right args? (This is what catches Phase 1's bug.)
- **A before/after runner** — one command that scores a change.
- **Learn:** aptkit's `evals` package (scorers, RubricJudge). **Build by hand.**
- **Ref:** `.aipe/study-ai-engineering/05-evals-and-observability/`, `.aipe/study-testing/`.

### Phase 1 — Fix the known result-killers
Small, high-return, and they de-risk everything after.
- **Tool-arg validation** in the Gemma emulation — the *wrong-key → empty-search silent failure*, buffr's single biggest correctness bug. Gate with the Phase-0 tool-use eval.
- **Test `session.ts` / chat** — the untested surface, so Phase 2 refactors are safe.
- **Learn:** the tool-dispatch path + emulated tool-calling in the Gemma provider.
- **Ref:** `.aipe/study-ai-engineering/04-agents-and-tool-use/`, `.aipe/study-testing/`.

### Phase 2 — The runtime agent loop · *your stated core goal*
Open `run-agent-loop.ts` and make it yours. Read `study-agent-architecture` alongside it. Each change eval-gated:
- **Sequential in-prompt conversation history** — thread prior turns (today each question is answered independently; biggest "feels smarter" win).
- **Tool-call repair** — a structured retry on a malformed call, not one nudge.
- **A reflection / self-correction step** — optional; measure whether it actually helps.
- **Learn:** the ReAct loop, forced synthesis, the turn/tool budget — by editing them.
- **Ref:** `.aipe/study-agent-architecture/01-reasoning-patterns/`, `04-agent-infrastructure/`.

### Phase 3 — Add tools · *"web search + look into my DB schemas"*
Each tool teaches the registry + policy + the agentic decision of *when* to use it.
- **Web search tool** — external I/O; the agent choosing web vs knowledge base.
- **DB-schema introspection tool** — read-only queries over your app schemas (buffr, blooming_insights, contrl). First real step back toward the **Hermes-shaped "agent that knows my apps"** north star — answering about your actual data, not just indexed docs.
- **Tool policy as it grows** — least-privilege scoping (the security lens gets real once tools do more than read).
- **Learn:** the tool contract, multi-tool orchestration, tool safety.
- **Ref:** `.aipe/study-agent-architecture/02-agentic-retrieval/`, `.aipe/study-security/`.

### Phase 4 — Smarter retrieval
RAG-quality levers, each proven by precision@k + faithfulness.
- **Reranking**, **hybrid (keyword + vector)**, **query rewriting / HyDE**, **chunking-strategy tuning**.
- **Learn:** the retrieval pipeline internals.
- **Ref:** `.aipe/study-ai-engineering/03-retrieval-and-rag/`.

### Phase 5 — UX / serving
- **Token streaming** (Gemma provider `stream: true` + the OpenTUI UI), richer chat surface, better conversation continuity.
- **Ref:** `.aipe/study-frontend-engineering/`, `.aipe/study-ai-engineering/06-production-serving/`.

---

## Manual vs AI-built — the rubric

```
  BUILD BY HAND (to learn)          LET AI BUILD (once you know the pattern)
  ──────────────────────           ────────────────────────────────────────
  the agent loop internals          the 5th tool (after you hand-built the 1st)
  the eval scorers                  tests, migrations, boilerplate glue
  the Gemma tool-emulation           a new VectorStore / embedder adapter
  anything you're trying to master   the labeled eval-set scaffolding, docs
```

**The one rule:** never let AI build the thing you're *currently trying to understand*. Let it build the neighbors of what you've already learned. Review every line — reading AI's code of a component you know is itself a fast way to learn.

---

## The known-gaps backlog (from the study guides)

These are already documented, grounded, and slot into the phases above:

| Gap | Phase | Source |
| --- | --- | --- |
| Faithfulness eval unwired (RubricJudge exists) | 0 | study-ai-engineering/05 |
| Labeled eval set is ~3 items | 0 | study-testing |
| Tool-arg validation missing (silent empty search) | 1 | study-ai-engineering/04 |
| `session.ts`/chat untested | 1 | study-testing |
| No in-prompt conversation threading | 2 | study-agent-architecture |
| No web/hybrid/rerank retrieval | 3,4 | study-ai-engineering/03 |
| No streaming | 5 | study-ai-engineering/06 |
| `app_id` shape-only / no RLS (matters once tools write) | 3 | study-security |

---

## Start here

**Phase 0 (evals).** It's the ruler for everything else, and you've flagged it repeatedly. Turn it into a step-by-step TDD implementation plan and build the harness first. Then Phase 1's fixes are the first changes you measure with it.
