# Orchestration system-design templates

> SECTION F. Three generic agentic-system templates, each reframing the
> "design an agentic X" interview prompt. The standard-architecture / data-model
> / scale / eval / failure bullets are generic. The **Applies to this codebase**
> and **How to make it apply** bullets are answered about buffr only.
>
> This file is also where buffr's **not yet exercised** multi-agent material
> lives honestly: buffr is one agent (`audit.md`, Lens 3). Each template names
> the concrete refactor in buffr's files that would adopt the topology — design
> targets, not current code.

Uses the nine-bullet template shape (not the per-concept format).

---

## Template 1 — Multi-agent research assistant

- **The prompt:** "Design a system that answers a complex research question by
  gathering from multiple sources and synthesizing."
- **Standard architecture:** supervisor decomposes the question → parallel
  worker agents each retrieve from a source (agentic RAG per worker) →
  supervisor synthesizes with citations.

```
  Fan-out + synthesis

       ┌──── supervisor: split into sub-questions ────┐
       ▼              ▼                ▼
  ┌─────────┐   ┌─────────┐      ┌─────────┐
  │ worker 1│   │ worker 2│      │ worker 3│   (concurrent, agentic RAG each)
  │ source A│   │ source B│      │ source C│
  └────┬────┘   └────┬────┘      └────┬────┘
       └─────────────┼─────────────────┘
                     ▼
            supervisor synthesizes → cited answer
```

- **Data model:** source registry, per-worker retrieval indices, a shared
  findings store keyed by sub-question, citation provenance.
- **Key components:** decomposition (supervisor), parallel retrieval (workers,
  fan-out), synthesis (merge agent), citation tracking. Decision per component:
  tools-style vs handoff-style delegation; shared state vs message passing.
- **Scale concerns:** fan-out cost at many sources; iteration blowup at deep
  questions (cap it); the supervisor becomes the bottleneck at high volume —
  cheap workers, expensive supervisor only.
- **Eval framing:** trajectory eval (did each worker hit the right source?),
  answer groundedness (every claim cites a retrieved chunk), cost/latency per
  question.
- **Common failure modes:** synthesis of contradictory sources, citation
  hallucination, cost blowup from deep loops, lost-in-the-middle across many
  worker results.
- **Applies to this codebase:** **partially.** buffr has the *worker* half — one
  agentic-RAG loop over pgvector with citation-bearing results
  (`03-agentic-retrieval.md`; `toResult` builds `[docId] snippet` citations,
  `search-knowledge-base-tool.js:54-64`). It has no supervisor, no
  decomposition, no fan-out, no synthesis-across-workers. It is exactly one
  worker running standalone.
- **How to make it apply:** add a supervisor capability above `RagQueryAgent`
  that (1) decomposes the question into sub-queries, (2) runs N `RagQueryAgent`
  instances concurrently with `Promise.all` (each already app-scoped via
  `app_id`, so multi-source = multiple corpora), (3) merges their cited results.
  Concretely: a new `src/cli/research-cmd.ts` plus a supervisor agent in aptkit;
  the existing `RagQueryAgent` becomes the worker unchanged. The
  shared-findings store is a natural fit for a new `agents.findings` table keyed
  by sub-question. **This is the deferred "two-brain" direction in
  `agent-layer-plan.md`** — explicitly out of scope until the single agent is
  measured (`agent-layer-plan.md:18`).

---

## Template 2 — Agentic support / task system

- **The prompt:** "Design an agent that resolves user requests by taking real
  actions across tools, and escalates when it can't."
- **Standard architecture:** intent router → single agent with tools (ReAct) →
  guardrails (input sanitize, action gating, output schema) → human escalation
  on low confidence or gated actions.

```
  ReAct loop with a control envelope

  input ─► [input guardrail] ─► ┌─ agent loop (ReAct) ─┐ ─► [output guardrail] ─► answer
                                │ iteration cap         │
                                │ token/cost budget     │
                                │ human gate on actions │
                                └───────────────────────┘
                                        │ low confidence / gated
                                        ▼ escalate to human
```

- **Data model:** conversation/run history with tool calls and confidence per
  turn, escalation log, tool registry, action audit trail.
- **Key components:** routing, the agent loop, guardrails, escalation gate,
  audit logging. Decision: which actions require human approval (irreversible /
  high-stakes) vs auto-execute.
- **Scale concerns:** tool-call cascade under load, cost per resolved request,
  escalation queue as the human bottleneck.
- **Eval framing:** resolution rate without escalation, tool-call accuracy,
  adversarial set (prompt injection, out-of-scope), action-safety (no
  unauthorized side effects).
- **Common failure modes:** prompt injection in user input, agent taking an
  unsafe action directly, infinite loop on an unsolvable request, hallucinated
  tool results.
- **Applies to this codebase:** **partially — this is buffr's closest match.**
  buffr has the ReAct loop with a tight control envelope (turn/tool caps +
  forced synthesis, `01-bounded-react-loop.md`), least-privilege tool scope
  (`02-single-tool-capability-scope.md`), and a full run/tool-call audit trail
  (`04-trajectory-as-memory.md`). What it lacks: an intent router, *action*
  tools (its one tool is read-only, so there's nothing to gate), confidence
  scoring, and a human-escalation path. It's a *read-only* agentic assistant,
  not an action-taking one.
- **How to make it apply:** the moment you add a write tool (say
  `index_document` or `compose_vlog` — buffr's domain per
  `.aipe/project/context.md`), three things become mandatory: (1) widen
  `ragQueryToolPolicy.allowedTools` *and* add an action-gating step before the
  write executes (`rag-query-agent.js:8-11` is where scope is decided); (2) an
  output guardrail validating the agent's final structured action; (3) an
  escalation branch when confidence is low. Input sanitization of the user
  question and defense against indexed-content injection
  (`.aipe/study-security/03-indirect-prompt-injection-surface.md`) move from
  "nice" to "required" once actions are reversible side effects.

---

## Template 3 — Agentic coding / build system

- **The prompt:** "Design an agent that completes a coding task across a repo —
  read, plan, edit, verify."
- **Standard architecture:** plan-and-execute (plan the changes, then execute
  per file) + verifier-critic (run tests / review the diff, loop on failure) +
  guardrails (scope the writable files, cap iterations).

```
  plan → execute → verify loop

  ┌─ plan ──┐  steps  ┌─ execute ──┐  diff  ┌─ verify ──┐
  │ list    │ ──────► │ edit per   │ ─────► │ tests /   │
  │ changes │         │ file       │        │ review    │
  └─────────┘         └────────────┘        └─────┬─────┘
        ▲                                         │ fail
        └──────────── re-plan trigger ────────────┘ (cap rounds)
```

- **Data model:** repo context (file tree, relevant files retrieved), the plan,
  the diff, test results, an iteration counter.
- **Key components:** retrieval over the codebase, planning, execution (edits),
  verification (tests/review), the re-plan trigger on verification failure.
  Decision: plan-and-execute vs pure ReAct for the edit loop.
- **Scale concerns:** large repos blow the context budget (retrieval routing
  over the codebase), long tasks blow the iteration cap, cost per task.
- **Eval framing:** task success (tests pass), trajectory efficiency (edits and
  re-plans to completion), regression rate.
- **Common failure modes:** editing files outside scope, plan assumptions
  breaking mid-execution (re-plan), verifier sharing the producer's blind spots,
  context loss across long tasks.
- **Applies to this codebase:** **no.** buffr is a read-only RAG agent; it has no
  plan phase, no edit tools, no verifier, no diff. The only overlapping piece is
  retrieval-over-a-corpus, and buffr's corpus is indexed documents, not a repo's
  file tree.
- **How to make it apply:** this is the largest refactor of the three — buffr
  would need to grow from read-only retrieval into plan-and-execute with edit
  tools and a verifier loop. That means: a planner capability (the missing
  plan-and-execute pattern, `audit.md` Lens 1), write/edit tools behind a
  scoped allowlist, and a verifier agent (the missing debate/verifier-critic
  topology). It's far enough from buffr's design (a *knowledge* assistant, not a
  *coding* one) that it's better treated as a different product than a refactor.

---

## What these templates surface about buffr

```
  buffr vs the three templates

  research assistant   → partially (the worker, not the orchestrator)
  support / task       → partially (read-only ReAct + envelope; no actions)
  coding / build       → no        (different product shape)
```

The honest read: buffr is **one worker-shaped agent** that maps onto the
*single-agent half* of templates 1 and 2. Every multi-agent extension —
supervisor, fan-out, synthesis, verifier, handoff — is a forward direction the
codebase has *deliberately not taken yet* (`agent-layer-plan.md:13-18`: ship one
agent, measure it, then maybe generalize). The refactors above are real and
mostly additive (the existing `RagQueryAgent` becomes a worker untouched), which
is the signal that the single-agent foundation was built to compose later — not
a dead end.

---

## See also

- `audit.md` — Lens 3 (multi-agent: not yet exercised)
- `01-bounded-react-loop.md` — the single-agent loop these templates build on
- `02-single-tool-capability-scope.md` — where action-gating would extend
- `04-trajectory-as-memory.md` — the audit-trail half of the support template
- `agent-layer-plan.md` — the deferred multi-agent / two-brain direction
