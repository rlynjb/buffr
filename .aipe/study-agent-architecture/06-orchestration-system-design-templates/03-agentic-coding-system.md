# System design template — agentic coding / build system

Reframes buffr as the answer to "design an agent that completes a coding
task across a repo." Generic bullets first; the last two about buffr
only. This is the template furthest from buffr's current shape — and the
honest distance is the lesson.

- **The prompt:** "Design an agent that completes a coding task across a
  repo — read, plan, edit, verify."

- **Standard architecture:** plan-and-execute (plan the changes, then
  execute per file) + verifier-critic (run tests / review the diff, loop
  on failure) + guardrails (scope the writable files, cap iterations).

  ```
  task → PLAN (decompose into per-file edits)
              ▼
        EXECUTE per file (edits) ──► VERIFY (tests / review)
              ▲                          │ fail
              └────── re-plan on failure ─┘  (cap iterations)
  ```

- **Data model:** repo context (file tree, relevant files retrieved),
  the plan, the diff, test results, an iteration counter.

- **Key components:** retrieval over the codebase (which files matter),
  planning, execution (edits), verification (tests/review), the re-plan
  trigger on verification failure. Decision: plan-and-execute vs pure
  ReAct for the edit loop.

- **Scale concerns:** large repos blow the context budget (retrieval
  routing over the codebase), long tasks blow the iteration cap, cost per
  task.

- **Eval framing:** task success (tests pass), trajectory efficiency
  (edits and re-plans to completion), regression rate (did it break
  something else).

- **Common failure modes:** editing files outside scope, plan
  assumptions breaking mid-execution (re-plan), the verifier sharing the
  producer's blind spots, context loss across long tasks.

- **Applies to this codebase:** **no — but two ingredients are already
  here.** buffr is a personal-knowledge RAG assistant, not a coding
  agent: it has no plan-and-execute, no edit tool, no verifier, no
  writable-file scope. Its one tool is read-only retrieval. That said,
  two of this template's components exist in buffr in primitive form. (1)
  *Retrieval over a corpus* — buffr's `RagQueryAgent` retrieving relevant
  chunks is the same shape as "retrieve which files matter," just over
  notes instead of code (`02-agentic-retrieval/01-agentic-rag.md`). (2)
  *The bounded loop with iteration caps* — `runAgentLoop`'s
  `maxTurns`/`maxToolCalls` and forced synthesis are exactly the
  iteration guardrail a coding agent needs (`run-agent-loop.js:25-34`).
  buffr has the retrieval substrate and the control envelope; it has none
  of the plan/edit/verify machinery.

- **How to make it apply:** this is a large refactor — buffr would become
  a different system. (1) Replace the single read-only tool with a tool
  *set*: read-file, write-file (scoped to a writable-file allowlist),
  run-tests. (2) Add a planning call before the loop that decomposes the
  task into per-file edits — the plan-and-execute split
  (`01-reasoning-patterns/04-plan-and-execute.md`), which buffr doesn't
  have. (3) Add a verifier-critic loop: run tests after edits, and on
  failure feed the result back and re-plan
  (`03-multi-agent-orchestration/05-debate-verifier-critic.md`) — ideally
  with a different model family for the critic. (4) Convert the imperative
  loop toward graph orchestration so a human can approve the diff before
  it's applied. Gating item: this is the template buffr is *least* shaped
  for — it would require an edit tool (abandoning the read-only blast
  radius that's buffr's strongest guardrail), a planner, and a verifier.
  Naming that distance honestly is the point: buffr is a retrieval
  assistant, and turning it into a coding agent is a rebuild, not a
  refactor.

## See also

- `01-reasoning-patterns/04-plan-and-execute.md` — the planner half
- `03-multi-agent-orchestration/05-debate-verifier-critic.md` — the
  verifier half
- `04-agent-infrastructure/05-guardrails-and-control.md` — the
  writable-file scope and human gate this needs
