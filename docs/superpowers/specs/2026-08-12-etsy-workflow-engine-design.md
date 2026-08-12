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
master agent, and do not let an LLM control lifecycle routing. The workflow engine owns the lifecycle;
LLM-backed modules return structured judgments inside the boundary assigned to them.

```
Etsy API (read-only)
        │
        ▼
Etsy Connector ──► Normalized evidence store
                         │
                         ▼
                 Workflow Engine
       ┌───────────────┼────────────────┐
       │               │                │
   validation      routing/state     persistence
       │               │                │
       ▼               ▼                ▼
 M1 Context → M2 Metrics → M4 Diagnosis → M5 Hypothesis → M6 Test Plan
                      │                         │
                      └── M3 Research ◄─────────┘
                                                    │
                                                    ▼
                                      real-world experiment waits
                                                    │
                                                    ▼
                                      M2 Results → M7 Learning
```

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

**M3 Research** is a bounded conditional detour. A calling module emits structured research status;
the engine records the requester, runs M3 within limits, and returns the research result only to the
calling module. M3 may choose among permitted tools inside its defined research scope, but it cannot
select the lifecycle stage or alter the workflow route.

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

- `status`: `resolved`, `partly-resolved`, or `unresolved`.
- `requester`: the module that requested research.
- `question`: the specific bounded research question.
- `evidence`: cited evidence found by permitted tools.
- `confidence`: a normalized confidence value.
- `limitations`: what remains unknown or weakly supported.

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

## Documentation folder structure

This is the intended structure for the future implementation. This spec does not create these
application files.

```text
buffr/
├── .env                         # local, ignored placeholders
├── docs/
│   ├── module-prompts/          # architectural prompt sources
│   ├── system-design-plan/      # source-of-truth workflow docs
│   └── superpowers/
│       ├── specs/
│       └── plans/
├── src/
│   ├── index.ts                 # temporary entry point
│   ├── core/
│   │   ├── policy.ts            # M0 shared policy
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
│   │   ├── context.ts           # M1
│   │   ├── metrics.ts           # M2
│   │   ├── research.ts          # M3
│   │   ├── diagnosis.ts         # M4
│   │   ├── hypothesis.ts        # M5
│   │   ├── test-definition.ts   # M6
│   │   └── evaluation.ts        # M7
│   ├── prompts/
│   │   └── modules/
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
- M3 is documented as a bounded read-only research detour with citations, status, evidence,
  confidence, and safeguards.
- The Etsy connector and credential boundary are documented without changing the existing Etsy
  configuration boundary.
- Local files are explicitly justified for the first single-user version, and the database deferral
  boundary is clear.
- The folder structure is included as a documentation artifact only.

## Self-review

- Placeholders: there are no unresolved markers or empty sections; future files are intentionally
  listed as architecture targets, not created by this documentation-only change.
- Contradictions: the spec consistently assigns lifecycle routing to deterministic TypeScript and
  judgment to bounded Agents SDK modules.
- Ambiguity: M3 may choose permitted tools inside its scope, but only the engine chooses lifecycle
  stages and transition routes.
- Scope: this spec documents the approved design only; it does not implement code, dependencies,
  connector behavior, chat UX, onboarding, billing, voice, or web app work.
