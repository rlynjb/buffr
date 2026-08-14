# buffr

Self-hosted personal agent — being rebuilt from scratch, phase by phase, using
*AI Agents in Action* as a reference.

There is no implementation yet. See `docs/superpowers/specs/` for the design of
the current phase and `docs/superpowers/plans/` for its implementation plan.
Both directories also hold an archive of specs and plans for the deleted aptkit
implementation; current files are named `2026-08-09-buffr-reset-scaffold-*`,
while archived specs and plans are dated earlier. Prior implementation is
available in git history before the reset commit.

## Current architecture direction

The approved Etsy workflow engine pattern is a **deterministic workflow orchestrator with bounded agentic workers**.

A deterministic TypeScript engine owns routes, validation, state, and wait/stop
conditions. M1-M7 Agents SDK modules do bounded evidence interpretation and
return structured outputs. M3 may choose among permitted read-only Etsy and web
search tools within engine limits, but it cannot choose lifecycle routing.

Agent modules will live in self-documenting folders under `src/agents/<role>/`
with `agent.ts`, co-located Markdown prompts, and a concise module `README.md`;
shared contract definitions remain in `src/contracts/`.

Original high-level diagram:

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

Annotated pattern diagram:

```
+--------------------------- Ports and adapters boundary -------------------------+
| external systems                                                               |
| Pattern: Ports and Adapters                                                    |
|                                                                                |
| Etsy API (read-only) ---> Etsy Connector ---> Normalized evidence store         |
|                            Folder target: src/connectors/etsy/                 |
|                            Folder: src/contracts/                              |
|                                                                                |
| External Web Search ---> hosted web-search adapter (no local source file)       |
|                            cited research edge                                  |
+------------------------------------+-------------------------------------------+
                                     |
                                     v
+--------------------------------------------------------------------------------+
| Workflow Engine: Folder: src/workflow/                                          |
| Pattern: Finite State Machine / deterministic workflow orchestrator             |
+------------------------------+------------------------+------------------------+
| Validation / Gates           | Routing / State        | Pattern: Repository    |
| File: guards.ts              | File: routes.ts        | File: src/storage/runs.ts |
| schemas + evidence checks    | File: state.ts         | RunRepository port     |
| transition allowed?          | pause/wait/resume      | JsonFileRunRepository  |
|                              | complete/stop          | -> local JSON files    |
+------------------------------+------------------------+------------------------+
                                     |
             +-----------------------+-----------------------+
             |                                               |
             v                                               v
M0 shared policy/runtime configuration          +--------------------------------------------------------------+
Folder: src/agents/core/; not a state turn      | Pattern: Strategy + FSM route                                |
File: src/agents/core/policy.md                 | Workflow Engine = Context                                   |
File: src/agents/core/policy.ts                 | File: src/agents/runner.ts                                  |
                                                | SpecialistModule.run(input) -> structured output             |
                                                | Folder target: src/agents/context/; src/agents/metrics/     |
                                                | Folder target: src/agents/diagnosis/; src/agents/hypothesis/ |
                                                | Folder target: src/agents/test-definition/; src/agents/evaluation/ |
                                                |                                                              |
                                                |  Main lifecycle FSM                 Conditional M3 sidecar    |
                                                |                                                              |
                                                |  +----------------+                                          |
                                                |  | M1 Context     |                                          |
                                                |  +----------------+                                          |
                                                |          | context accepted                                    |
                                                |          v                                                     |
                                                |  +----------------+    - - research needed - -+                |
                                                |  | M2 Metrics     |---------------------------|                |
                                                |  +----------------+                           |                |
                                                |          | metrics calculated                  |                |
                                                |          v                                     |                |
                                                |  +--------------------------+                  |                |
                                                |  | evidence sufficient gate |                  |                |
                                                |  +--------------------------+                  |                |
                                                |          | no: request_data                    |                |
                                                |          +----> +-------------------+          |                |
                                                |          |      | request-data wait |          |                |
                                                |          |      +-------------------+          |                |
                                                |          |              | resume_with_data     |                |
                                                |          |              +-- back to M2 above   |                |
                                                |          | yes: evidence_sufficient            |                |
                                                |          v                                   |                |
                                                |  +----------------+    - - research needed - -|                |
                                                |  | M4 Diagnosis   |---------------------------|                |
                                                |  +----------------+                           |                |
                                                |          | allowed: diagnose                  |                |
                                                |          v                                   |                |
                                                |  +----------------+    - - research needed - -|                |
                                                |  | M5 Hypothesis  |---------------------------|                |
                                                |  +----------------+                           |                |
                                                |          | allowed: propose                   |                |
                                                |          v                                   |                |
                                                |  +----------------+    - - research needed - -|                |
                                                |  | M6 Test Plan   |---------------------------|                |
                                                |  +----------------+                           |                |
                                                |          | test plan approved                 |                |
                                                |          v                                   |                |
                                                |  +-----------------+                         |                |
                                                |  | experiment wait |                         |                |
                                                |  +-----------------+                         |                |
                                                |          | outcome data received              |                |
                                                |          v                                   |                |
                                                |  +----------------+                          |                |
                                                |  | M2 Results     |                          |                |
                                                |  +----------------+                          |                |
                                                |          | allowed: evaluate                  |                |
                                                |          v                                   |                |
                                                |  +----------------+    - - research needed - -|                |
                                                |  | M7 Learning    |---------------------------|                |
                                                |  +----------------+                           |                |
                                                |          | allowed: learn                     |                |
                                                |          v                                   v                |
                                                |  +----------------+        +--------------------------------+  |
                                                |  | cycle complete |        | M3 Research sidecar            |  |
                                                |  +----------------+        | Pattern: Bounded ReAct Loop    |  |
                                                |                          | + Circuit Breaker              |  |
                                                |                          | conditional; not linear stage   |  |
                                                |                          | bounded ReAct/tool-use loop     |  |
                                                |                          | Folder target: src/agents/research/ |
                                                |                          | caps source: Folder: src/workflow/ |
                                                |                          | circuit breaker caps            |  |
                                                |                          | calls / time / budget           |  |
                                                |                          | records original requester      |  |
                                                |                          | read-only Etsy Connector lookups|  |
                                                |                          | External Web Search citations   |  |
                                                |                          +--------------------------------+  |
                                                |                                      | structured result             |
                                                |                                      v                               |
                                                |                          return only to requesting state;    |
                                                |                          same M2/M4/M5/M6/M7 box resumes     |
                                                +--------------------------------------------------------------+
```

| Capability | Pattern / alternative name | Plain implementation name |
| --- | --- | --- |
| Workflow lifecycle | Finite State Machine / deterministic workflow orchestrator | TypeScript engine with explicit routes and lifecycle states |
| Transition checks | Gates / guard clauses / schema validation | Zod-backed guards |
| Persistence | Repository pattern + ports-and-adapters | `JsonFileRunRepository`; local persistent JSON files with atomic writes, not browser local storage |
| M1-M7 modules | Strategy-like specialist agent modules / structured outputs | Agents SDK stage modules |
| M3 Research | Bounded agentic tool-use loop / ReAct-style research loop with circuit breaker | Read-only tool choice and evidence interpretation inside engine caps |
| Etsy and web search | Ports and adapters / external tool adapters | Replaceable read-only connector/search adapters |
| M0 Core | Shared policy/runtime configuration | Shared module policy and limits, not a workflow turn |

Pattern guide:

**Finite State Machine / deterministic workflow orchestrator**:
`src/workflow/routes.ts`, `guards.ts`, `state.ts`, and `engine.ts` define the
explicit workflow stages, allowed transitions, validation gates, wait states,
and completion paths. The lifecycle route is code-owned, not chosen by an LLM.

**Repository pattern / ports and adapters**: `src/storage/runs.ts` defines the
engine-facing `RunRepository` contract and the `JsonFileRunRepository` adapter.
The workflow depends on the repository contract; readable JSON files and atomic
writes stay behind the adapter boundary.

**Ports and adapters**: `src/connectors/etsy/` and external web-search tool
adapters sit at the edge of the system. The core workflow works with normalized
evidence and shared contracts in `src/contracts/`, so external systems remain
replaceable.

**Bounded agentic tool-use loop / ReAct-style research loop with circuit
breaker**: `src/agents/research/` is the M3 research module home, while
`src/workflow/` enforces call, time, budget, and return-to-requester rules. M3
may choose permitted read-only research tools, but it does not control lifecycle
routing.

**Strategy-like specialist agent modules**: `src/agents/<role>/` holds the
role-focused M1-M7 module convention, and `src/agents/runner.ts` is the shared
structured-output runner. M0 policy plus focused prompts, readmes, and contracts
keep the modules consistent without making them one general-purpose agent.

**Functional core, imperative shell**: deterministic contracts and workflow
state live in `src/contracts/` and `src/workflow/`. LLM calls, Etsy calls,
web-search calls, and file I/O stay at the edges in agents, connectors, and
storage adapters.

Etsy listing changes remain manual. The first user interface comes later as a
terminal-chat adapter after the workflow is proven.

See `docs/superpowers/specs/2026-08-12-etsy-workflow-engine-design.md` for the
detailed design.
