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
| decides whether transitions  | pause, wait, resume,   | JsonFileRunRepository /|
| may proceed                  | complete               | local JSON files /     |
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
                                    read-only tools; returns to requester
                                    |
                                    +-- OpenAI hosted web search
                                        (Ports and adapters / external tool adapter)
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

Etsy listing changes remain manual. The first user interface comes later as a
terminal-chat adapter after the workflow is proven.

See `docs/superpowers/specs/2026-08-12-etsy-workflow-engine-design.md` for the
detailed design.
