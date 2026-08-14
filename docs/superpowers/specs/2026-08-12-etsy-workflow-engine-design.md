# Etsy workflow engine design

**Date:** 2026-08-12
**Status:** Approved design, documentation only

## Goal

Build the first version around one Etsy seller: the project owner. The first implementation phase
should prove the workflow engine's inputs, pauses, state transitions, evidence gates, and outputs
before adding a terminal-chat interface as an adapter.

The eventual product direction is a useful tool for Etsy sellers, but this phase does not include
seller onboarding, billing, voice UX, hosted multi-user infrastructure, or a web app.

## Recommended architecture

Use a deterministic TypeScript workflow engine with specialist Agents SDK modules. Do not build one
master agent, and do not let an LLM control lifecycle routing. M0 is shared policy/runtime
configuration for every module, not a state-machine turn. The workflow engine owns the lifecycle;
LLM-backed modules return structured judgments inside the boundary assigned to them.

```
Etsy API (read-only)
        |
        v
Etsy Connector (Ports and adapters / external tool adapter)
        |
        v
Normalized evidence store
        |
        v
+--------------------------------------------------------------------------------+
| Workflow Engine: Finite State Machine / deterministic workflow orchestrator     |
| owns explicit allowed routes and lifecycle states                               |
+------------------------------+------------------------+------------------------+
| Gates / guard clauses /      | Finite State Machine   | Repository pattern +   |
| schema validation            | routing/state          | ports-and-adapters     |
| decides whether transitions  | transition, pause,     | persistence:           |
| may proceed                  | wait, resume, complete | JsonFileRunRepository /|
|                              |                        | local JSON files /     |
|                              |                        | atomic writes          |
+------------------------------+------------------------+------------------------+
        |
        v
M0 shared policy/runtime configuration for M1-M7 (not a state-machine turn)
        |
        v
Strategy-like specialist agent modules / structured outputs

Primary lifecycle:
M1 Context -> M2 Metrics -> M4 Diagnosis -> M5 Hypothesis -> M6 Test Plan
                                                        |
                                                        v
                                      real-world experiment waits
                                                        |
                                                        v
                                      M2 Results -> M7 Learning

Bounded research detour:
M2 Metrics    <--- request/result ---> M3 Research
M5 Hypothesis <--- request/result ---^
                                    Bounded agentic tool-use loop /
                                    ReAct-style research loop with circuit breaker
                                    permitted read-only tools; returns to requester
                                    |
                                    +-- OpenAI hosted web search
                                        (Ports and adapters / external tool adapter)
```

Pattern mapping:

| Capability | Pattern / alternative name | Simple implementation name |
| --- | --- | --- |
| Workflow lifecycle | Finite State Machine / deterministic workflow orchestrator | TypeScript engine with explicit allowed routes and lifecycle states |
| Transition checks | Gates / guard clauses / schema validation | Zod-backed guards that decide whether transitions may proceed |
| Routing/state | Finite State Machine | State transitions for pause, wait, resume, and complete |
| Persistence | Repository pattern + ports-and-adapters | `RunRepository` port and `JsonFileRunRepository`; local persistent JSON files with atomic writes, not browser local storage |
| M1-M7 modules | Strategy-like specialist agent modules / structured outputs | Agents SDK module per stage returning validated structured output |
| M3 Research | Bounded agentic tool-use loop / ReAct-style research loop with circuit breaker | LLM may choose permitted read-only tools and interpret evidence; engine caps calls, time, and budget; M3 returns to its requester without lifecycle-routing authority |
| Etsy connector and web search | Ports and adapters / external tool adapters | Read-only Etsy connector and hosted web search adapters |
| M0 Core | Shared policy/runtime configuration | Shared module policy and limits, not a state-machine turn |

## Architecture patterns

The primary description for interviews is: **deterministic workflow orchestrator with bounded
agentic workers**.

This design combines several complementary industry patterns:

- **Workflow orchestration / state machine:** the engine defines explicit routes, loops, stop
  states, and waits. Stages do not advance because an LLM says so; they advance when deterministic
  route guards and evidence gates allow it.
- **Manager-worker:** the deterministic engine manages M1 through M7 specialist workers. Each worker
  receives a scoped input, performs its stage-specific reasoning, and returns structured output to
  the engine.
- **Hexagonal architecture / ports and adapters:** Etsy API access, hosted web search, local-file
  persistence, and the future terminal-chat interface are adapters around the workflow core. The
  core should depend on stable ports and normalized contracts, so those adapters can be replaced
  without rewriting lifecycle logic.
- **Functional core, imperative shell:** deterministic calculations, validation rules, and state
  transitions belong in the core. LLM calls, Etsy API calls, web search, file I/O, tracing, and
  future terminal-chat interaction sit at the imperative edge.
- **Human-in-the-loop:** recommendations are manual. The system can propose experiments and listing
  changes for the user to approve and apply, but it does not automatically edit Etsy listings.

The differentiator is bounded agentic behavior. The model may choose tools and interpret evidence
only inside permitted modules such as M3, under engine-enforced limits and contracts. It never gets
control over business-process or lifecycle routing.

## Component responsibilities

**Etsy API (read-only)** is Etsy Open API v3 accessed through read-only OAuth permissions. It is the
source for shop, listing, and transaction evidence, not a target for automatic changes.

**Etsy Connector** fetches from Etsy and maps endpoint-specific responses into normalized evidence.
It is the only layer that should know Etsy endpoint shapes. Raw endpoint details and credential
material must not leak into workflow modules.

**Normalized evidence store** holds connector output in a workflow-friendly shape. Modules consume
evidence records and derived metrics, not raw Etsy responses.

**Workflow Engine** is custom deterministic TypeScript. It owns allowed transitions, evidence gates,
validation, state, stop and wait conditions, persistence calls, and lifecycle routing. It chooses
which module runs next using explicit state and guard rules, not model-generated routing.

**Validation** checks that incoming evidence, module requests, module outputs, and experiment plans
match Zod contracts before the engine advances state.

**Routing/state** encodes the allowed graph. It prevents modules from skipping lifecycle stages,
calling unrelated modules, or continuing when an evidence gate or wait condition has not been met.

**Persistence** records runs, evidence snapshots, module outputs, research requests, experiment
plans, waits, and learning results in local files for the first single-user version.

**M0 Core** is shared policy and runtime configuration for all M1 through M7 modules. It is not a
standalone workflow turn. It defines shared rules such as read-only recommendations, evidence
quality expectations, confidence vocabulary, citation requirements, safety limits, and structured
output conventions.

**M1 Context** summarizes the seller, shop, listings, constraints, and stated goals from normalized
evidence and user-provided context.

**M2 Metrics** computes and explains deterministic performance signals. It also runs after a
real-world experiment wait as **M2 Results**, comparing post-experiment evidence with the planned
measurement window.

**M3 Research** is a bounded conditional detour. A calling module emits a structured research
request; the engine records the requester, runs M3 within configured hard limits, and returns the
research result only to the calling module. M3 may choose among permitted tools inside its defined
research scope, but it cannot select the lifecycle stage or alter the workflow route.

**M4 Diagnosis** interprets context, metrics, and any returned research to identify likely causes of
performance problems or opportunities.

**M5 Hypothesis** turns diagnosis into testable, evidence-backed hypotheses. It may request bounded
M3 research when outside evidence is needed before proposing a hypothesis.

**M6 Test Plan** converts one approved hypothesis into a manual experiment plan with success
criteria, measurement windows, expected signals, and stop/wait conditions.

**Real-world experiment waits** are explicit state pauses. The engine persists the planned wait and
resumes only when the user or scheduled future mechanism supplies the next evidence snapshot.

**M7 Learning** evaluates results against the hypothesis and records what changed in the seller's
local knowledge base for future recommendations.

## Routing boundary

The engine, not an LLM, owns:

- Allowed transitions from M1 to M7.
- Evidence gates and readiness checks.
- Structured validation of module inputs and outputs.
- Stop, wait, resume, and completion conditions.
- Persistence and trace event emission.
- Whether a bounded M3 research detour is allowed.
- Returning M3 output only to the module that requested it.

The specialist modules own:

- Judgment-heavy interpretation inside a single stage.
- Structured outputs that match Zod contracts.
- Evidence and confidence explanations.
- Tool selection only where a module is explicitly granted tools.

This keeps the workflow understandable and testable. TypeScript code controls deterministic
calculation and lifecycle flow; Agents SDK modules provide bounded judgment where deterministic code
would be brittle.

## M3 research rules

M3 uses only read-only tools. It must run with maximum call count, time, and budget safeguards. Each
research result must include:

- `status`: `resolved`, `partly_resolved`, or `unresolved`.
- `next_action`: `continue` or `stop`.
- `requester`: the module that requested research.
- `question`: the specific bounded research question.
- `evidence`: cited evidence found by permitted tools.
- `confidence`: a normalized confidence value.
- `limitations`: what remains unknown or weakly supported.

`status` describes whether the research question was answered. It does not control lifecycle
routing. The canonical normalized values are:

- `resolved`: the evidence answers the bounded research question well enough for the caller to use.
- `partly_resolved`: the evidence reduces uncertainty but leaves material limitations.
- `unresolved`: reliable information is insufficient or unavailable.

`next_action` describes only M3's recommendation for the research loop. M3 may recommend `continue`
only when another permitted lookup has a concrete reason, such as a named source to check, a
specific missing Etsy evidence record, or a clearly bounded citation gap. M3 recommends `stop` when
it is ready to return its structured finding. The engine honors `continue` only while the invocation
stays within configured hard limits; once a limit is reached, the engine forces `stop` and returns
the best structured finding available. Do not add a `blocked` M3 status: unresolved research is
represented by `status: unresolved`.

Initial design defaults, configurable pending implementation:

- Maximum 3 research tool calls per M3 invocation.
- Maximum 2 minutes wall-clock time per M3 invocation.
- A per-run cost/token budget must be chosen and configured before a real API-backed run.

These are upper safety bounds, not automatic targets. M3 should stop as soon as the bounded question
is adequately answered or cannot be improved by another permitted lookup. Implementation may tighten
or change these defaults through configuration.

External web research is open-web research with citations required. Version-one M3 tools are:

- Read-only Etsy connector functions for listing details, shop/listing transactions, and normalized
  evidence lookup.
- OpenAI hosted web search with citations.

Agents SDK can later support file search, code interpreter, custom function tools, and MCP tools.
Those capabilities are not version-one scope.

## Data and access

The Etsy connector uses Etsy Open API v3 through read-only OAuth. Recommendations are manual-only:
the system can propose listing changes, experiments, and measurement plans, but it must not
automatically change Etsy listings or shop settings.

Credentials stay in local ignored settings and are accessible only through a future connector
configuration layer, following `docs/superpowers/specs/2026-08-12-etsy-api-configuration-boundary-design.md`.
The workflow engine must never access `.env`, raw API keys, OAuth client secrets, refresh tokens, or
token file contents.

## Tech stack

- TypeScript and Node.js for the application and deterministic workflow engine.
- OpenAI Agents SDK for judgment-heavy specialist modules.
- Zod for contracts, validation, and structured outputs.
- Custom deterministic TypeScript workflow engine for lifecycle control.
- Etsy Open API v3 read-only OAuth connector.
- OpenAI hosted web search with citations for bounded M3 research.
- Local-file persistence for initial runs, evidence snapshots, and experiment plans.
- Node test runner or Vitest with mocked Etsy and OpenAI tools.
- Agents SDK tracing plus structured workflow events.
- Terminal-chat interface later, implemented as an adapter over proven engine inputs, pauses, and
  outputs.

## Persistence choice

Local files are appropriate for the first version because the system serves one known Etsy seller on
one developer-controlled machine. File persistence is inspectable, easy to back up, simple to test,
and enough for sequential workflow runs, evidence snapshots, experiment plans, waits, and learning
records.

A database is deferred until the product needs hosted multi-user access, concurrent runs, richer
querying, access control, background workers, account isolation, or operational observability that
local files cannot provide cleanly.

## Post-build next actions

After the workflow engine exists and its non-networked tests pass, the next work should proceed in
this order:

1. Configure real Etsy API and OAuth credentials in the local ignored `.env` file.
2. Run an OAuth connection validation through the future connector configuration layer.
3. Run one representative listing through the initial analysis and test-plan route.
4. Manually apply one approved experiment in Etsy. No Etsy listing changes are automated.
5. Return with outcome data after the experiment window so M2 Results and M7 Learning can run.
6. Review run traces, evidence snapshots, module outputs, and persisted experiment plans; refine
   prompts and contracts where the trace shows ambiguity or weak structure.
7. Build the terminal-chat adapter after the engine's inputs, pauses, and outputs are proven.

## Documentation folder structure

This is the intended structure for the future implementation. This spec does not create these
application files.

```text
buffr/
├── .env                         # local, ignored placeholders
├── docs/
│   ├── system-design-plan/      # source-of-truth workflow docs
│   └── superpowers/
│       ├── specs/
│       └── plans/
├── src/
│   ├── index.ts                 # temporary entry point
│   ├── core/
│   │   ├── config.ts            # validated app configuration
│   │   └── errors.ts
│   ├── contracts/
│   │   ├── evidence.ts
│   │   ├── workflow.ts
│   │   ├── modules.ts
│   │   └── experiments.ts
│   ├── workflow/
│   │   ├── engine.ts            # deterministic orchestration
│   │   ├── routes.ts            # allowed transitions/gates
│   │   ├── state.ts             # persisted run state
│   │   └── guards.ts            # evidence and readiness checks
│   ├── agents/
│   │   ├── runner.ts            # shared Agents SDK adapter
│   │   ├── core/                # M0 shared policy/runtime configuration
│   │   │   ├── policy.ts
│   │   │   ├── policy.md
│   │   │   └── README.md
│   │   ├── context/             # M1
│   │   │   ├── agent.ts
│   │   │   ├── prompt.md
│   │   │   └── README.md
│   │   ├── metrics/             # M2 initial and M2 results
│   │   │   ├── agent.ts
│   │   │   ├── prompt.md
│   │   │   └── README.md
│   │   ├── research/            # M3 bounded research
│   │   │   ├── agent.ts
│   │   │   ├── prompt.md
│   │   │   └── README.md
│   │   ├── diagnosis/           # M4
│   │   │   ├── agent.ts
│   │   │   ├── prompt.md
│   │   │   └── README.md
│   │   ├── hypothesis/          # M5
│   │   │   ├── agent.ts
│   │   │   ├── prompt.md
│   │   │   └── README.md
│   │   ├── test-definition/     # M6
│   │   │   ├── agent.ts
│   │   │   ├── prompt.md
│   │   │   └── README.md
│   │   └── evaluation/          # M7
│   │       ├── agent.ts
│   │       ├── prompt.md
│   │       └── README.md
│   ├── connectors/
│   │   └── etsy/
│   │       ├── client.ts
│   │       ├── auth.ts
│   │       ├── mapper.ts
│   │       └── repository.ts
│   ├── storage/
│   │   └── runs.ts
│   └── tests/
│       ├── workflow/
│       ├── agents/
│       └── connectors/
└── package.json
```

Each `src/agents/<role>/README.md` is a concise module card. It documents purpose, when the
module runs, input contract, output contract, dependencies, permitted tools, success/stop/pause/
failure conditions, and links back to the related design documents. The README references shared
contracts in `src/contracts/`; it must not duplicate those contract definitions.

Prompt text stays co-located in each module folder as Markdown. TypeScript owns schema validation,
model calls, deterministic helpers, and tool wiring. M0 uses `src/agents/core/policy.md` and
`policy.ts` instead of a standalone workflow turn.

## Out of scope

- Application code.
- Runtime dependency changes.
- Edits to the existing Etsy configuration boundary spec.
- Etsy seller onboarding.
- Billing.
- Voice UX.
- Web app or hosted product shell.
- Automatic Etsy listing or shop mutations.
- Connector implementation.
- Terminal-chat implementation before the engine contract is proven.

## Done means

- The workflow-engine architecture is documented as deterministic routing plus specialist modules.
- M0 is documented as shared policy/runtime configuration, not a workflow turn.
- M3 is documented as a bounded read-only research detour with citations, canonical status,
  `next_action`, evidence, confidence, and configurable safeguards.
- The Etsy connector and credential boundary are documented without changing the existing Etsy
  configuration boundary.
- Local files are explicitly justified for the first single-user version, and the database deferral
  boundary is clear.
- The architecture is explainable as a deterministic workflow orchestrator with bounded agentic
  workers, using workflow orchestration, manager-worker, ports/adapters, functional core, and
  human-in-the-loop patterns.
- The agent module folder convention is documented: runtime TypeScript, Markdown prompt or policy,
  and a concise README live together under `src/agents/<role>/`, while shared contracts remain in
  `src/contracts/`.
- The folder structure is included as a documentation artifact only.

## Self-review

- Placeholders: there are no unresolved markers or empty sections; the only intentional future
  choice is the per-run cost/token budget that must be configured before a real API-backed run.
- Contradictions: the spec consistently assigns lifecycle routing to deterministic TypeScript and
  judgment to bounded Agents SDK modules; M3 `next_action` controls only its research loop.
- Ambiguity: M3 may choose permitted tools inside its scope and recommend `continue` or `stop`, but
  only the engine enforces limits and chooses lifecycle stages and transition routes.
- Architecture patterns: the interview-facing pattern names describe the same boundaries already in
  the spec and do not introduce a separate implementation scope.
- Module organization: module folders improve navigation and prompt ownership without moving shared
  contracts out of `src/contracts/` or adding duplicate schema definitions.
- Scope: this spec documents the approved design only; it does not implement code, dependencies,
  connector behavior, chat UX, onboarding, billing, voice, or web app work.
