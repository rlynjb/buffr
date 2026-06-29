# 03 — Agentic Coding System

**Prompt:** *"Design an agent that completes a coding task across a repo — read, plan, edit,
verify."*

The canonical answer is a **plan-and-execute loop wrapped in a verifier-critic loop, fenced
by guardrails**. Unlike a Q&A agent, this one *changes the world* (writes files) and then has
to *prove* it didn't break anything. The design is dominated by the verify edge and the
file-scope fence.

```
  STANDARD ARCHITECTURE — plan → execute → verify, fenced
  ┌───────────────────────────────────────────────────────────────────────────┐
  │  task: "add input validation to the login handler"                          │
  └───────────────────────────────────┬─────────────────────────────────────────┘
                                       ▼
                            ┌─────────────────────┐
                            │   PLAN               │  read repo → produce step list
                            │  (read + decompose)  │  (which files, what edits)
                            └─────────┬───────────-┘
                                      ▼
        ┌───────────────────────── EXECUTE ────────────────────────────────┐
        │   ┌──────────┐   edit    ┌──────────────┐                          │
        │   │  AGENT   │ ────────► │ WRITE TOOLS  │  apply edit to file       │
        │   │          │ ◄──────── │ (scoped)     │  within writable scope    │
        │   └──────────┘  diff     └──────────────┘                          │
        └───────────────────────────────┬──────────────────────────────────┘
                                         ▼
        ┌───────────────────────── VERIFY ─────────────────────────────────┐
        │   ┌──────────────┐  run   ┌──────────────┐                         │
        │   │ VERIFIER/    │ ─────► │ tests · build │  collect signal         │
        │   │ CRITIC       │ ◄───── │ · lint        │                         │
        │   └──────┬───────┘ result └──────────────┘                         │
        │          │ pass → done                                             │
        │          │ fail → critique → back to PLAN  (bounded retries)       │
        └──────────┴────────────────────────────────────────────────────────┘
              ▲                                                  │
              └──── GUARDRAILS: writable-file scope · iteration cap · diff review
```

Three loops nested: an execute loop inside a verify loop inside a guardrail fence. buffr has
none of these — it neither plans, edits, nor verifies. This is the furthest template from
what buffr is.

## Standard architecture

- **Plan (read + decompose):** read the relevant repo files, produce an ordered edit plan —
  which files, what change, in what order. Plan-and-execute, not pure ReAct, because edits
  have dependencies.
- **Execute (edit):** apply edits via write tools, one step at a time, producing diffs.
- **Verify (critic):** run tests / build / lint, collect the signal, and *critique* — pass →
  done; fail → feed the failure back into a re-plan. The verifier is what separates a coding
  agent from a code generator.
- **Guardrails:** scope which files are writable (don't let it edit CI config or secrets),
  cap iterations (no infinite edit-fail-edit), and surface diffs for review.

## Data model

- **Repo / file tree:** the editable surface, plus a *writable-scope allow-list*.
- **Plan object:** ordered steps with target files and intended changes.
- **Diff / patch store:** proposed and applied edits, for review + rollback.
- **Verification results:** test/build/lint output keyed to the plan step that caused them.
- **Trajectory:** plan → edits → verify cycles, for replay and for the critic's context.

## Key components

- **Planner:** Decision — upfront full plan vs. incremental (plan one step, execute, re-plan).
  Incremental survives surprises better; upfront is cheaper.
- **Editor / write tool:** Decision — whole-file rewrite vs. targeted patch. Patches are
  safer (smaller blast radius) but need exact-match anchoring.
- **Verifier-critic:** Decision — deterministic gate (tests must pass) vs. LLM critic
  (judgement on style/intent). Real systems use both: tests as the hard gate, LLM critic for
  the soft stuff.
- **Scope guard:** the writable-file allow-list — the single most important safety component.
- **Iteration cap:** bounds the verify-retry loop.

## Scale concerns

- **Large repos:** can't fit the repo in context; needs retrieval/grep to find the right
  files before planning.
- **Slow verification:** if the test suite takes 20 min, the verify loop dominates wall-clock;
  needs test selection / incremental builds.
- **Edit conflicts:** parallel edits or a moving base require rebase/merge handling.
- **Cascading edits:** one change forces N follow-ups; the planner must bound the blast
  radius or the task never converges.

## Eval framing

- **Task success:** does the change do what was asked AND keep the suite green? (SWE-bench
  shape: resolved vs. not.)
- **Diff quality:** minimal, on-scope, no collateral edits.
- **Verify-loop efficiency:** how many edit→fail→re-plan cycles to converge.
- **Regression safety:** did it break anything outside the task? Run the *full* suite, not
  just the touched tests.
- **Trajectory eval:** replay plan→edit→verify, assert the scope guard held.

## Common failure modes

- **Edits outside scope:** agent "fixes" the test instead of the code, or edits files it
  shouldn't.
- **Verify gaming:** weakens an assertion to make a failing test pass.
- **Plan/execute drift:** plan says one thing, edits do another.
- **Infinite verify loop:** edit→fail→edit→fail without convergence, no cap.
- **Context blindness:** edits a file without reading its callers, breaks them silently.

## Applies to this codebase: **NO**

This is the clean **no**. buffr is a read-only Q&A loop — it does not plan, does not edit,
does not verify. Every one of this template's three loops is absent.

Against the four verbs — read, plan, edit, verify:

- **Read:** buffr reads, but only a *vector store*, not a repo. Its read is
  `search_knowledge_base` over `PgVectorStore` wired at
  `/Users/rein/Public/buffr/src/session.ts:41-44` — retrieval, not source-file reading.
- **Plan:** **no planner.** `RagQueryAgent.answer()`
  (`/Users/rein/Public/aptkit/packages/agents/rag-query/src/rag-query-agent.ts:62-83`) runs a
  flat ReAct loop — search, then synthesize. No step list, no plan object. (Plan-and-execute
  is itself flagged not-yet-exercised in SECTION A 04 of this guide.)
- **Edit:** **no write tools at all.** `ragQueryToolPolicy` grants exactly one read tool
  (`rag-query-agent.ts:15-18`). Nothing in buffr changes a file.
- **Verify:** **no verifier-critic.** The forced-synthesis finish at
  `/Users/rein/Public/aptkit/packages/runtime/src/run-agent-loop.ts:101-109` ends the loop —
  it does not critique an output and loop back. (Verifier-critic loops are also flagged
  not-yet-exercised in SECTION A 05.)

There is no writable-file scope guard because there's nothing writable. There's no diff store
because there are no diffs. The whole template describes an agent that *mutates and proves*,
and buffr does neither.

## How to make it apply

There is no honest "small refactor" here — reaching this template is **building a different
agent**. The pieces:

1. **Add plan-and-execute** (the pattern SECTION A 04 marks not-yet): a planner that reads the
   repo and emits an ordered edit plan, replacing the flat loop in `rag-query-agent.ts:62-83`.
2. **Add write/edit tools**: file-edit tools in the registry wired at `session.ts:43-44`, and
   the corresponding grant in an expanded `ragQueryToolPolicy` (`rag-query-agent.ts:15-18`).
3. **Add a verifier-critic loop** (the pattern SECTION A 05 marks not-yet): run tests/build,
   critique, and feed failures back into a re-plan — a genuine loop the current forced-finish
   at `run-agent-loop.ts:101-109` does not support.
4. **Add file-scope guardrails**: a writable-file allow-list, the coding analogue of buffr's
   existing capability scoping — but over the filesystem, which buffr has never touched.

Honest framing: **this is the furthest template from buffr's current shape.** The other two
templates wrap or extend buffr's existing loop. This one replaces it. buffr today is a thing
that *answers questions about a corpus*; a coding agent is a thing that *plans, mutates, and
verifies a repo*. Different verbs, different control flow, different guardrails — the only
reusable instinct that survives the rebuild is "scope the agent's powers tightly," which
buffr already demonstrates in miniature at `rag-query-agent.ts:15-18`.
