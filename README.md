# buffr

Buffr is a self-hosted product-growth work engine.

It takes small, trusted evidence packets from products and marketplaces, validates
them, runs them through a deterministic workflow, and produces a human-approved
experiment plan or learning record. The first product shape is for seller and
marketplace workflows: Etsy listing analysis, MerchGrid business health, and
marketplace visibility reviews.

The important design rule is simple: TypeScript owns the workflow lifecycle, and
LLM-backed modules provide bounded judgment inside that lifecycle. Buffr does not
let a model decide which business-process stage runs next, and it does not apply
real-world marketplace changes automatically.

## Table of contents

- [Product mental model](#product-mental-model)
- [What Buffr does](#what-buffr-does)
- [Current workflows](#current-workflows)
- [System at a glance](#system-at-a-glance)
- [Buffr through a systems-thinking lens](#buffr-through-a-systems-thinking-lens)
- [Subsystem inventory](#subsystem-inventory)
- [Sources and trust boundaries](#sources-and-trust-boundaries)
- [Technology stack](#technology-stack)
- [Workflow lifecycle](#workflow-lifecycle)
- [Agent modules](#agent-modules)
- [Data boundaries](#data-boundaries)
- [Persistence and artifacts](#persistence-and-artifacts)
- [How to read the codebase](#how-to-read-the-codebase)
- [Local setup](#local-setup)
- [Core commands](#core-commands)
- [MerchGrid operations](#merchgrid-operations)
- [Marketplace visibility operations](#marketplace-visibility-operations)
- [Etsy connector validation](#etsy-connector-validation)
- [Safety rules](#safety-rules)
- [Design references](#design-references)

## Product mental model

Buffr is an evidence-to-decision system.

```text
raw or curated sources
  |
  v
source adapters
  |
  v
normalized evidence contracts
  |
  v
deterministic workflow engine
  |
  v
bounded specialist modules
  |
  v
manual approval gate
  |
  v
experiment plan or learning record
```

Think of Buffr as a careful analyst for small product operators. It does not
need every raw event, private dashboard, or marketplace control. It needs enough
safe, normalized evidence to answer one operational question:

> What should the owner test next, why, and how will they know whether it
> worked?

The product is intentionally conservative. It can recommend listing changes,
visibility experiments, measurement windows, and follow-up learning. The owner
still applies marketplace or product changes manually.

## What Buffr does

Buffr helps answer questions like:

- Is there enough evidence to diagnose a product or listing problem?
- Are metrics missing, partial, stale, or good enough to use?
- What is the most plausible cause of a drop-off or visibility problem?
- What hypothesis should be tested next?
- What manual experiment should the owner run?
- After the wait window, did the result support the hypothesis?
- What should be remembered for future recommendations?

It is not a hosted SaaS product yet. The current version is a local,
single-owner workflow engine with file persistence, command-line workflows, and
mockable module boundaries.

## Current workflows

Buffr currently has three product-facing workflow families.

| Workflow | Current entry point | Product surface | What it produces |
| --- | --- | --- | --- |
| Etsy listing workflow | Shared engine/API path; connector-validation scaffold only at the CLI | Etsy seller listing evidence | A listing experiment plan and later learning record |
| MerchGrid daily/weekly workflow | `merchgrid:*` commands | Aggregate business and reliability metrics | Daily diagnosis, weekly recommendation, approval wait, and result learning |
| Marketplace visibility workflow | `marketplace:next-review` | Sparse metrics plus curated product/listing context and optional public research | A rolling, low-risk visibility experiment recommendation with evidence references |

These workflows share the same core engine pattern. The source evidence differs,
but the lifecycle remains deterministic and contract-driven.

## System at a glance

Buffr is a **local evidence-to-decision system** built around a deterministic
workflow orchestrator and bounded agentic specialists. The diagram below shows
the complete system implemented in this repository. External providers and the
owner's real-world actions sit outside Buffr's trust boundary.

```text
                     OUTSIDE BUFFR: SOURCES AND REAL-WORLD ACTIONS

 PostHog API    Fly Metrics API    Shopify aggregate CSV    Etsy API
      |                |                    |                  |
      +----------------+--------------------+------------------+
                               |
 Curated product/listing JSON -+       OpenAI model + hosted public web
                               |                    |
                               v                    v
+============================================================================+
|                         BUFFR SYSTEM BOUNDARY                              |
|                                                                            |
|  [1] CONNECTORS AND COLLECTION              [2] MODEL + RESEARCH PORTS    |
|  Etsy mapper; PostHog/Fly/CSV adapters;     structured agent runner;      |
|  local-context loaders; completed-UTC       bounded read-only web search  |
|               |                                      |                     |
|               v                                      v                     |
|  [3] RUNTIME-VALIDATED CONTRACTS <---------- structured outputs -----------|
|  normalized evidence, metrics, module outputs, workflow state, plans       |
|               |                                                            |
|        +------+----------------------+                                     |
|        |                             |                                     |
|        v                             v                                     |
|  [4] SOURCE PACK                [5] PRODUCT ENTRY SERVICES                 |
|  snapshots -> daily health      start Etsy evidence directly; load and    |
|  -> weekly review artifacts     qualify MerchGrid/visibility evidence     |
|        |                             |                                     |
|        +-----------------------------+                                     |
|                                      v                                     |
|  [6] DETERMINISTIC WORKFLOW ENGINE <------> [7] M1-M7 AGENT MODULES        |
|  routes, guards, state, waits, approval,     bounded interpretation via   |
|  research caps, resume, trace events          [2]; structured output only  |
|                     |                        M3 returns to its requester     |
|                     v                                                      |
|  [8] LOCAL FILE REPOSITORIES AND ARTIFACTS                                 |
|  metric snapshots; daily/weekly reviews; run.json; evidence; events; plan  |
|                     |                                                      |
+=====================|======================================================+
                      v
             [9] HUMAN APPROVAL GATE
                      |
             owner makes a manual change
                      |
              experiment wait / delay
                      |
              later aggregate evidence
                      |
                      +------> back through Buffr to M2 Results and M7 Learning
```

What each boundary means:

- Provider credentials are handled only by configuration and connector/tool
  boundaries. They do not cross into evidence, workflow state, prompts, traces,
  or artifacts.
- Provider-specific payloads are mapped or aggregated before the workflow sees
  them. The workflow consumes only Zod-validated Buffr contracts.
- The TypeScript engine decides which stage can run. A model can interpret
  evidence inside a stage, but cannot bypass guards, approval, research limits,
  or wait states.
- `run.json` is the durable source of truth for a workflow run. Metric snapshot
  files are the source of truth for collected daily aggregates. Human-readable
  plans, evidence files, and JSONL events are derived projections.
- Buffr produces recommendations and records learning. It never applies an
  Etsy, Shopify, or other marketplace change automatically.

## Buffr through a systems-thinking lens

You do not need to have read Donella H. Meadows's *Thinking in Systems* to use
this section. Systems thinking is simply a way to understand software by asking
how the whole system behaves over time—not only which folders and classes it
contains. The vocabulary below gives a junior developer a repeatable set of
questions: What is the system trying to accomplish? What does it remember? What
changes that memory? Where does information enter and leave? What makes the
system wait, continue, or stop?

### Purpose: what job does the whole system perform?

A system's **purpose** is the outcome produced by all of its parts working
together. It is different from the responsibility of a single module. For
example, M3's responsibility is public web research, but that is not Buffr's
overall purpose.

Buffr's purpose is to turn a small, trusted packet of product evidence into one
safe next experiment, then turn the experiment's delayed result into recorded
learning. A typical input might say that listing visibility declined during a
completed measurement window. The desired output is not an automatic listing
edit; it is a reviewable experiment plan that explains the evidence, reasoning,
uncertainty, and supporting research references. The owner decides whether to
run the experiment and makes the real-world change manually.

For a junior developer, this purpose is the first design test for any proposed
feature: does it improve the evidence-to-experiment-to-learning loop, or does it
introduce unrelated automation? Buffr optimizes for better, safer decisions—not
for the largest possible number of autonomous actions.

### System boundary: what is inside Buffr, and what is outside?

A **system boundary** is the line around the behavior and data that Buffr owns.
The boundary is about responsibility and control, not merely where code runs.
Anything crossing it should be treated as untrusted until a Buffr contract has
validated and normalized it.

Inside the boundary are the CLIs, connectors, contracts, source-pack pipeline,
profile services, workflow engine, M1-M7 modules, M3 research adapter, local
repositories, and trace events. These components decide how Buffr accepts
evidence, advances a run, records state, and presents a recommendation.

Outside the boundary are provider systems such as Etsy, PostHog, Fly, Shopify,
and the public web; credential stores; schedulers and dashboards; and the
owner's actual marketplace edits. Buffr may read through a narrow adapter, but
it does not own those systems. In particular, M3 may search permitted public
sources and return validated citations, while credentials, raw provider
payloads, and arbitrary browsing remain outside the workflow state.

When adding a feature, first ask which side of this boundary it belongs on. If
external information enters Buffr, add or reuse an adapter and validate the
result at the boundary. If a real-world action leaves Buffr, preserve the human
approval gate instead of hiding the action inside a module.

### Stocks: what does Buffr remember?

A **stock** is state that exists at a point in time and remains available after
the operation that produced it has finished. In this repository, a stock does
not have to live in a database: a validated JSON file can be durable state too.
Stocks let a later command resume a run or explain how a decision was reached.

| Stock | What it means in Buffr | Where it is stored | Why it is retained |
| --- | --- | --- | --- |
| Daily metric snapshots | One normalized aggregate result per source and completed UTC day | `snapshots/<source>/<date>.json` | Reuse stable observations without recollecting or silently rewriting history |
| Daily and weekly reviews | Product-health evidence derived from snapshots | `artifacts/daily-health/` and `artifacts/weekly-reviews/` | Give profile services a qualified, human-readable evidence packet |
| Workflow run state | Current stage, status, evidence references, module outputs, approval, and events | `workflow-runs/<run-id>/run.json` | Resume safely and explain the current state of one decision cycle |
| Experiment plan | M6's reviewable recommendation with evidence and research references | `workflow-runs/<run-id>/experiment-plan.json` | Let the owner inspect the proposed experiment without reading internal run state |
| Learning state | Post-experiment M2 result and M7 evaluation retained in the workflow run | `workflow-runs/<run-id>/run.json` | Preserve what happened and what the system concluded from it |

The **source of record** is the authoritative copy used to answer “what is true
right now?” Completed snapshot files are authoritative for collected daily
aggregates, and `run.json` is authoritative for a workflow run. Daily reviews,
weekly reviews, experiment plans, evidence files, and event streams are useful
projections of that state; they should not independently redefine it. This
distinction matters during debugging: start with the source of record, then
check whether a projection was built correctly.

### Flows: what changes those stocks?

A **flow** is an operation that creates, transforms, or appends to a stock. A
connector response is not automatically trusted state. It becomes part of the
system only after the appropriate flow validates, normalizes, and persists it.

1. Evidence enters through an approved connector or local input: Etsy listing
   evidence, curated marketplace context, PostHog and Fly aggregates, or a
   Shopify Partner CSV.
2. Boundary code parses the input into Buffr contracts. Metrics collection
   paths persist normalized daily snapshots; direct workflow paths build a
   validated evidence packet.
3. Source-pack jobs reuse completed snapshots to derive daily-health artifacts
   and adjacent seven-day weekly reviews. They derive a new view; they do not
   change the historical snapshots.
4. A product/profile service checks that the evidence is complete enough and
   then starts or resumes a workflow run.
5. The deterministic engine advances the legal M1-M7 stages. Each module can
   add a validated output, but the module cannot choose an illegal transition.
6. When a module raises a concrete public-research question, the engine makes a
   bounded M3 detour. M3 adds validated search summaries and citations to the
   run, then returns control to the requesting stage.
7. M6 produces an experiment plan. The owner approves or rejects it and, if
   approved, performs the marketplace change outside Buffr.
8. After the measurement period, qualified result evidence re-enters through
   M2 Results. M7 evaluates it and records the learning in the run.

When debugging a flow, follow one transformation at a time: identify its input
contract, validator, output contract, and persistence call. This is usually more
reliable than starting inside an AI prompt and trying to reason backward.

> **Tracing note:** Buffr's application-level trace and the OpenAI Agents SDK
> trace describe different layers of the same flow. Buffr records durable
> business events—such as module start and completion, stage transitions,
> waits, research activity, and owner approval—in the authoritative `run.json`
> event history and the derived `events.jsonl` view. An OpenAI Agents SDK trace
> describes execution inside an AI step, including model runs, tool calls,
> timing, and token usage. The local trace answers “what happened to this Buffr
> workflow?”; the SDK trace answers “what did the agent and its tools do during
> this AI execution?” Buffr does not currently link these two trace layers.

> **TODO — link OpenAI Agents SDK traces:** Capture the SDK trace identifier for
> each model-backed module execution, associate it with the Buffr `runId`,
> module, and stage, and store that safe reference on the corresponding workflow
> event. Preserve `run.json` as the business-workflow source of record; use the
> SDK trace only as drill-down observability. Validate the reference before
> persistence, cover linked and unavailable-trace cases with network-free tests,
> and never copy credentials, private inputs, full prompts, or raw provider
> payloads into Buffr events.

### Feedback loop: how does a result affect the next decision?

A **feedback loop** exists when the result of an action returns as information
that can influence a later decision. Buffr's current Shopify visibility loop is
deliberately mediated by the owner:

```text
PRIOR EXPERIMENT RUN                         NEXT EXPERIMENT RUN

baseline -> diagnosis -> hypothesis -> M6 plan
                                          |
                                 owner edits Shopify
                                 manually, outside Buffr
                                          |
                                          v
fresh weekly artifact --------------------+-------------------------+
       |                                                            |
       | result role                                                | baseline role
       v                                                            v
M2 Results -> M7 -> completed run.json       new run.json -> M1 ... M6 -> approval wait
       |                                                            |
       +---------------- bounded learning --------------------------+

One `marketplace:next-review` invocation closes the left-hand run and creates
the right-hand run. The two run records stay separate; the artifact is reused
by reference rather than copied or reinterpreted as two different observations.
```

Here is the same loop as an operational sequence:

1. **Persist the observation window.** Collect aggregate signals for completed
   UTC dates. A rolling review needs enough persisted snapshots to form two
   adjacent seven-day periods. `merchgrid:weekly-review` may build the weekly
   artifact explicitly; if it is absent, the rolling command attempts the same
   local derivation. It never collects providers as part of the review.

2. **Run one rolling operation.** The only command-line choice is `--profile`.
   Think of the profile as a routing key: it selects the marketplace workflow,
   configured context paths, evidence rules, and module behavior for this kind
   of review.

   ```bash
   npm run marketplace:next-review -- \
     --profile merchgrid_shopify_app_store
   ```

   For `merchgrid_shopify_app_store`, Buffr loads the context configured by
   `MERCHGRID_VISIBILITY_CONTEXT_PATH` and the optional public listing context
   configured by `MERCHGRID_LISTING_CONTEXT_PATH`. The validated context
   supplies the stable `productRef`, such as `merchgrid-shopify-app`. The owner
   no longer enters that value, but Buffr still uses it internally to find the
   correct product history and prevent unrelated products from sharing runs.

   Buffr also scans the persisted snapshots and automatically chooses the
   newest completed UTC date backed by all three sources across both required
   seven-day periods. The owner no longer enters `--through`, but the resolved
   date is still recorded internally as `through` so the evidence window, run
   id, and later result comparison remain reproducible.

3. **Confirm the prior real-world action.** If Buffr finds an unresolved prior
   M6 plan for the exact `profile + productRef`, it asks whether the owner
   actually applied it. There is no default answer. A `yes` also requires the
   UTC application date; a `no` stops that prior run without inventing result
   metrics or M7 learning. Cancellation happens before workflow mutation.

4. **Close one run and create the next.** For an applied experiment, the fresh
   weekly artifact must contain the M6 primary metric and its current seven-day
   window must begin after the application date. Buffr uses it as the prior
   run's result, executes M2 Results and M7, and completes that `run.json`.
   Buffr then uses the same artifact reference as the new run's baseline,
   carries only the validated M7 learning projection, and advances the new run
   through M6. The generated run id is deterministic, so retrying the identical
   cycle does not repeat events, model calls, artifacts, or owner questions.

   M6 cannot invent a prose-only measurement here. Before a plan reaches the
   approval wait, Buffr requires `primaryMetric` to name an actual key in the
   validated baseline evidence and replaces any model-proposed baseline number
   with that evidence's value and period. This makes the later comparison
   reproducible instead of trusting the model to remember a metric or baseline.

5. **Review and act manually.** Inspect the new `experiment-plan.json`, decide
   whether to apply it, and make any Shopify change yourself. Buffr has no
   marketplace-write path. A later invocation with fresh weekly evidence will
   ask what actually happened before closing this run and opening another one.

For a junior developer, the important lesson is that an experiment plan is only
half of the product. A completed feedback loop needs a real owner action plus a
qualified later observation. Buffr makes their relationship traceable, but it
does not confuse a recommendation with an applied change or a new experiment
with an update to the old run.

### Delays: why does Buffr sometimes wait?

A **delay** is the time between an action and trustworthy evidence about its
effect. Software can execute immediately, but the business signal often cannot.
Buffr therefore waits for completed UTC collection windows, adjacent weekly
comparison windows, explicit owner approval, an experiment period, and
qualified post-experiment evidence.

These waits are correctness controls. Comparing a partial day with a completed
day can create a false decline, and evaluating a marketplace change too early
can mistake normal noise for an effect. Statuses such as `awaiting_approval`,
`ready_for_experiment`, and `waiting_for_data` make the delay visible and
resumable. They are valid workflow outcomes, not crashes or unfinished code.

When working on wait behavior, do not “fix” it by inventing missing evidence or
advancing the stage. Determine what real event or qualified input is required
to resume the run.

### Decision rules: what determines what happens next?

A **decision rule** is a deterministic condition that converts the current
state into an allowed next action. Buffr keeps these rules in schemas, readiness
checks, routes, and guards so that a model's interpretation cannot override
system safety.

| Rule | What it decides | Junior-developer interpretation |
| --- | --- | --- |
| Zod schemas | Whether untrusted input or module output has the required shape | Invalid data stops at the boundary instead of spreading through the run |
| Evidence readiness functions | Whether the available evidence is complete enough to use | “A file exists” is not the same as “the evidence qualifies” |
| Workflow routes and guards | Which stage may run next and which waits are required | The TypeScript engine, not the model, owns the state machine |
| M3 allowlists and call/time/token/cost caps | Which research tools can run and how much work they may do | Research is useful but intentionally bounded and read-only |
| Immutable completed snapshots | Whether historical daily evidence may be overwritten | Re-running collection cannot silently change an accepted observation |
| Human approval | Whether a proposed experiment may become a real-world action | A recommendation is not permission to modify a marketplace |

If you change one of these rules, test both the newly allowed path and the path
that must remain rejected. A permissive guard or schema change can affect every
module downstream even when the edit itself looks small.

### Leverage points: which small controls have a large effect?

A **leverage point** is a place where a focused change can alter the behavior of
the whole system. In Buffr, the highest-leverage safety control is human
approval: recommendations may accumulate, but only the owner can create a
real-world marketplace change. The normalized contract boundary is another
leverage point because every downstream module depends on the quality and
meaning of accepted evidence. M3's allowlist and resource caps are a third
because they control how an open-ended external activity enters a bounded,
repeatable workflow.

Leverage points deserve stricter review than ordinary presentation code. A
junior developer should ask, “How many downstream decisions rely on this rule?”
before changing an approval gate, contract, readiness check, route, or research
limit.

### Putting the concepts together: one M3-assisted run

Suppose a marketplace visibility run has valid local context but a diagnosis
needs current public evidence. The existing workflow run is the **stock**. A
module raises a structured research request, and the engine's research route is
the **flow**. The public web is outside the **system boundary**, so M3 uses only
permitted tools and validates citations before adding them to `run.json`. The
allowlist and resource caps are **decision rules**. The owner approval gate is a
**leverage point**. After the owner runs the experiment, Buffr respects the
measurement **delay**; result evidence later closes the **feedback loop** and M7
adds learning to the run.

That single example is the reason M3 has its own subsystem row below while
still participating in the shared agent runtime: research crosses an external
trust boundary and needs special tools, limits, citations, and validation, but
the workflow engine still owns when M3 runs and where its output goes.

## Subsystem inventory

| Subsystem | Responsibility | Primary implementation |
| --- | --- | --- |
| CLI and composition roots | Parse commands, load local configuration, and wire real adapters, repositories, engines, and modules | `src/cli/` |
| Core configuration and errors | Load `.env`, validate runtime settings, classify bounded errors, and identify prohibited credential keys | `src/core/` |
| Etsy connector | Read Etsy listing/transaction endpoints and map listing data into normalized evidence | `src/connectors/etsy/` |
| MerchGrid connectors | Collect approved aggregate signals from PostHog, Fly metrics, and the Shopify Partner CSV | `src/connectors/merchgrid/` |
| Marketplace context connector | Load and validate curated product context and public listing observations from local JSON | `src/connectors/marketplace/local-context.ts` |
| Metrics pipeline | Coordinate bounded source collection and build normalized evidence summaries | `src/metrics/` |
| Source-pack jobs | Reuse completed snapshots and derive daily-health and weekly-review artifacts | `src/jobs/merchgrid-source-pack.ts` |
| Contracts | Define runtime schemas for evidence, metrics, workflow state, M1-M7 outputs, and experiment plans | `src/contracts/` |
| Product entry services | Start Etsy evidence directly or translate MerchGrid/visibility evidence into the shared engine; validate result evidence | `src/workflow/engine.ts`, `src/workflow/merchgrid-profile.ts`, `src/workflow/marketplace-visibility-profile.ts` |
| Workflow control plane | Own stage transitions, guards, waits, research routing, approval, resume, and completion | `src/workflow/` |
| Agent runtime and modules | Sanitize model input and run OpenAI-backed structured specialists or deterministic workflow-specific implementations | `src/agents/runner.ts`, `src/agents/` |
| M3 research subsystem | Perform bounded read-only hosted search, validate citations, and return evidence only to the requester | `src/agents/research/` |
| Storage | Persist validated metric snapshots, workflow runs, evidence projections, events, and plans with atomic file replacement | `src/storage/` |
| Tracing | Create credential-checked structured workflow events | `src/tracing/events.ts` |
| Verification | Exercise contracts, connectors, workflows, storage, CLIs, and end-to-end behavior with fakes and temporary files | `src/tests/` |

The CLI files are the runtime composition roots. Tests replace their network,
clock, model, and filesystem dependencies with fakes; the domain and workflow
code do not reach into environment variables directly.

## Sources and trust boundaries

| Source | Access path | What enters Buffr | What is retained |
| --- | --- | --- | --- |
| PostHog | Read-only aggregate HogQL request through `PosthogMetricSourceAdapter` | Counts for four approved product events and a derived scan-completion rate | Normalized daily aggregate snapshot; no raw event rows |
| Fly Metrics API | Read-only Prometheus query through `FlyMetricsSourceAdapter` | Request count, 5xx response count, and derived error rate | Normalized daily aggregate snapshot; no raw response payload |
| Shopify Partner | Owner-exported aggregate CSV through `ShopifyPartnerCsvMetricSource` | Date, active merchants, installs, uninstalls, and earnings amount | Normalized daily aggregate snapshot; no merchant/customer records |
| Etsy API | Read-only `EtsyHttpClient` and `EtsyEvidenceRepository` | Listing evidence and transaction responses mapped at the connector boundary | Normalized listing evidence when used; credentials and token files are excluded |
| Product context JSON | Owner-curated local file | Product, customer, promise, constraints, owner goal, and marketplace surface | Validated marketplace visibility evidence |
| Listing context JSON | Owner-curated observations of a public listing | Headline, category, gallery count, trust signals, copy notes, and visual-review notes | Validated qualitative evidence; never conversion proof |
| OpenAI model | Structured module calls through `OpenAiAgentRunner` | Validated workflow context with credential-like keys removed | Validated module output and bounded usage metadata; not raw provider payloads |
| Public web | OpenAI hosted web search through the M3 adapter | A concrete question plus configured domain policy | Citation metadata, bounded search summaries, and research references; no page bodies |
| Result evidence | Owner-triggered result command using a later review artifact | Qualified aggregate signals after the experiment delay | Result evidence projection plus M2/M7 outputs in the existing run |

An implemented connector is not necessarily a complete product entry point.
For example, Etsy has a read-only connector and a shared workflow lifecycle, but
the current user-facing Etsy command is configuration validation rather than a
full listing-review CLI. `npm start` likewise loads only the scaffold entry
point; operational work runs through the workflow-specific commands below.

## Technology stack

| Layer | Technology used here |
| --- | --- |
| Language and runtime | Strict TypeScript, ES2022 target, Node.js ESM |
| Build and package tooling | `npm`, `package-lock.json`, TypeScript compiler (`tsc`) |
| Runtime validation | Zod strict schemas and discriminated unions |
| Agent/model integration | `@openai/agents`, structured outputs, hosted web-search tool |
| HTTP | Node's native `fetch`, `AbortController`, explicit timeouts |
| Configuration | Environment variables loaded locally with `dotenv` |
| Persistence | Node filesystem APIs, JSON snapshots/artifacts, JSONL event projections, atomic rename writes, per-snapshot lock directories |
| Testing | Vitest, dependency-injected fakes, fixed clocks, temporary directories, synthetic provider responses |
| User interface | Command-line scripts exposed through `npm`; no web UI or terminal chat runtime in this slice |
| Deployment/operations | Self-hosted local process; external scheduling is expected; no database, queue, or in-process scheduler |

The architecture combines a few standard implementation patterns:

| Capability | Pattern name | Where to look |
| --- | --- | --- |
| Lifecycle control | Finite state machine / workflow orchestrator | `src/workflow/engine.ts`, `src/workflow/routes.ts` |
| Transition checks | Guards / schema validation | `src/workflow/guards.ts`, `src/contracts/` |
| External systems | Ports and adapters | `src/connectors/` |
| Persistence | Repository pattern | `src/storage/runs.ts`, `src/storage/metric-snapshots.ts` |
| Product entry | Profile service / facade | `src/workflow/*-profile.ts` |
| LLM reasoning | Bounded specialist strategies | `src/agents/<role>/`, workflow-specific `modules.ts` files |
| Research detours | Tool-use loop with deterministic circuit breakers | `src/agents/research/`, `src/workflow/engine.ts` |

## Workflow lifecycle

The original Etsy lifecycle remains the clearest map for the whole product:

```text
M1 Context
  |
  v
M2 Metrics
  |
  v
M4 Diagnosis
  |
  v
M5 Hypothesis
  |
  v
M6 Test Plan
  |
  v
approval / real-world experiment wait
  |
  v
M2 Results
  |
  v
M7 Learning
```

M3 Research is not a normal linear stage. It is a bounded sidecar that another
module can request when outside evidence is needed.

```text
M2, M4, M5, M6, or M7
  |
  | structured research request
  v
M3 Research
  |
  | structured research result
  v
return only to the requesting module/stage
```

The engine owns:

- allowed transitions;
- evidence gates and readiness checks;
- module input and output validation;
- stop, wait, resume, and completion conditions;
- persistence and trace event emission;
- whether a research detour is allowed;
- returning M3 output only to the stage that requested it.

Specialist modules own:

- judgment inside one stage;
- structured outputs that match Zod contracts;
- confidence and evidence explanations;
- tool choice only when explicitly granted by the engine.

## Agent modules

Agent modules live under `src/agents/`.

| Module | Role | Folder |
| --- | --- | --- |
| M0 Core | Shared policy and runtime configuration, not a workflow turn | `src/agents/core/` |
| M1 Context | Summarize product/listing context, constraints, and owner goals | `src/agents/context/` |
| M2 Metrics | Compute and explain performance signals and post-experiment results | `src/agents/metrics/` |
| M3 Research | Run bounded read-only research and return cited findings | `src/agents/research/` |
| M4 Diagnosis | Identify likely causes or opportunities | `src/agents/diagnosis/` |
| M5 Hypothesis | Turn diagnosis into testable hypotheses | `src/agents/hypothesis/` |
| M6 Test Plan | Convert a hypothesis into a manual experiment plan | `src/agents/test-definition/` |
| M7 Learning | Compare results to the hypothesis and record what was learned | `src/agents/evaluation/` |

Most module folders follow this shape:

```text
src/agents/<role>/
  agent.ts      # TypeScript wrapper, schema validation, model/tool wiring
  prompt.md     # role-specific instructions
  README.md     # short module card for humans
```

Shared output contracts stay in `src/contracts/modules.ts`. Module READMEs
should explain purpose, inputs, outputs, dependencies, tools, and failure modes;
they should not duplicate the contract definitions.

There are also workflow-specific module sets:

- `src/agents/merchgrid/modules.ts`
- `src/agents/marketplace-visibility/modules.ts`

Those files adapt the general M1-M7 module idea to specific product workflows.

## Data boundaries

Buffr's most important boundary is between raw source data and normalized
evidence.

```text
provider-specific data
  |
  | connector owns provider details
  v
normalized evidence
  |
  | workflow and modules consume stable Buffr contracts
  v
module outputs and experiment plans
```

For a junior developer, `src/contracts/` is the best map of the product. The
contracts define what Buffr is allowed to know, save, and pass between stages.

Read these first:

| File | What it teaches |
| --- | --- |
| `src/contracts/README.md` | Product-language overview of the contracts |
| `src/contracts/evidence.ts` | Etsy/listing evidence |
| `src/contracts/metrics.ts` | Daily source snapshots |
| `src/contracts/merchgrid-workflow.ts` | MerchGrid review evidence |
| `src/contracts/marketplace-visibility.ts` | Sparse-data marketplace review evidence |
| `src/contracts/modules.ts` | M1-M7 module output shapes |
| `src/contracts/workflow.ts` | Durable workflow run state and event model |
| `src/contracts/experiments.ts` | Final experiment plan shape |

The workflow engine should not know raw Etsy endpoint shapes, PostHog API
responses, Fly response details, Shopify Partner CSV quirks, OAuth token files,
or environment variable names. Those belong at the adapter/configuration edge.

## Persistence and artifacts

The first version uses local files because Buffr currently serves one owner on
one developer-controlled machine. With the documented defaults, its data layout
is:

```text
artifacts/merchgrid/
  context/
    merchgrid-visibility-context.json       # owner-curated product input
    merchgrid-listing-context.json          # owner-curated public listing input
  sources/
    shopify-partner-aggregates.csv          # approved manual aggregate input
  metrics/                                  # MERCHGRID_METRICS_DATA_DIR
    snapshots/
      posthog/<YYYY-MM-DD>.json             # normalized daily source records
      fly_metrics/<YYYY-MM-DD>.json
      shopify_partner/<YYYY-MM-DD>.json
    artifacts/
      daily-health/<YYYY-MM-DD>.json        # derived one-day review evidence
      weekly-reviews/<YYYY-MM-DD>.json      # derived adjacent-week evidence
    workflow-runs/
      <run-id>/
        run.json                            # authoritative workflow state
        evidence/
          initial.json                     # reviewable evidence projection
          result.json                      # optional later evidence projection
        events.jsonl                       # reviewable trace projection
        experiment-plan.json               # M6 plan plus evidence/research refs
```

There are two local systems of record:

- A completed daily snapshot is the collection record for one source and UTC
  date. Completed snapshots are immutable; an incomplete snapshot may be
  replaced when collection later succeeds.
- `run.json` is the workflow record. It contains the current state and the
  validated module outputs needed to resume after a wait or process restart.

Daily/weekly reviews, separate evidence files, `events.jsonl`, and
`experiment-plan.json` are inspectable projections. They make review easier,
but they do not replace their underlying snapshots or `run.json`.

Writes use temporary files followed by atomic rename. Snapshot writers also use
a per-file lock directory, which protects a date/source record from concurrent
local writers. This is local process coordination, not a distributed lock.

The workflow run store supports one sequential local CLI process. Concurrent
CLI invocations that target the same run store are unsupported; do not schedule
overlapping workflow commands against it. Atomic replacement protects an
individual file write, but it is not a transaction around an OpenAI model or
hosted-research call. If a process crashes after a provider call completes but
before the resulting `run.json` state is durable, a retry may repeat that call.
Those provider executions therefore have at-least-once crash semantics at that
boundary. Once a transition is persisted, stage checks and deterministic cycle
IDs prevent an ordinary sequential retry from repeating the durable work.

Local file persistence is useful here because it is:

- inspectable during development;
- simple to back up;
- easy to test;
- enough for sequential workflow runs;
- transparent when reviewing evidence, waits, approvals, and learning records.

A database is deferred until Buffr needs hosted multi-user access, concurrent
runs, richer querying, account isolation, background workers, or production
observability that local files cannot handle cleanly.

Generated operational evidence and workflow artifacts live under `artifacts/`.
Real `.env` files, credentials, raw provider payloads, private customer data,
and unapproved source exports must stay out of git and out of persisted
workflow data.

## How to read the codebase

Use this order when learning Buffr:

1. Read `src/contracts/README.md`.
   This gives you the product vocabulary before you read implementation code.

2. Read the workflow core:
   - `src/workflow/engine.ts`
   - `src/workflow/routes.ts`
   - `src/workflow/guards.ts`
   - `src/workflow/state.ts`

3. Read one module end to end:
   - `src/agents/context/README.md`
   - `src/agents/context/prompt.md`
   - `src/agents/context/agent.ts`

4. Read the repository boundary:
   - `src/storage/runs.ts`
   - `src/storage/metric-snapshots.ts`

5. Read one connector family:
   - `src/connectors/etsy/`
   - or `src/connectors/merchgrid/`
   - or `src/connectors/marketplace/local-context.ts`

6. Read the CLI entry points:
   - `src/cli/merchgrid-source-pack.ts`
   - `src/cli/merchgrid-workflow.ts`
   - `src/cli/marketplace-visibility.ts`

7. Read tests beside the concept you are learning:
   - `src/tests/workflow/`
   - `src/tests/contracts/`
   - `src/tests/agents/`
   - `src/tests/connectors/`

The fastest mental model is: contracts define the language, connectors create
trusted evidence, the engine controls the lifecycle, modules make bounded
judgments, and storage records what happened.

## Local setup

Install dependencies from the lockfile:

```bash
npm ci
```

Build TypeScript:

```bash
npm run build
```

Run tests:

```bash
npm test
```

Run typechecking without emitting files:

```bash
npm run typecheck
```

For local commands that need credentials, copy `.env.example` to `.env` and
fill in local values. The commands load `.env` automatically; shell or
deployment-provided variables may override it. Never commit the real `.env`.

Common environment variable names:

- `OPENAI_API_KEY`
- `ETSY_API_KEY`
- `ETSY_OAUTH_CLIENT_ID`
- `ETSY_OAUTH_REDIRECT_URI`
- `ETSY_OAUTH_SCOPES`
- `ETSY_TOKEN_STORAGE_PATH`
- `ETSY_VALIDATE_LISTING_ID`
- `POSTHOG_PROJECT_ID`
- `POSTHOG_PERSONAL_API_KEY`
- `POSTHOG_BASE_URL`
- `FLY_ORG_SLUG`
- `FLY_ACCESS_TOKEN`
- `FLY_APP_NAME`
- `MERCHGRID_METRICS_DATA_DIR`
- `SHOPIFY_PARTNER_AGGREGATES_CSV_PATH`

Etsy connector validation uses the Etsy-related variables defined by
`src/core/config.ts` and the Etsy configuration-boundary design. The runtime
token provider remains an injected connector dependency; this repository does
not implement an OAuth login flow.

## Core commands

```bash
npm run build
npm test
npm run typecheck
npm start
```

`npm start` currently runs the built scaffold entry point. Most product behavior
is exercised through workflow-specific CLI commands and tests.

## MerchGrid operations

MerchGrid source-pack commands collect aggregate-only operational evidence. They
do not store raw merchant, shop, or customer data.

Place a manually exported, aggregate-only Shopify Partner CSV under
`artifacts/merchgrid/sources/`, for example:

```text
artifacts/merchgrid/sources/shopify-partner-aggregates.csv
```

The CSV may include only these columns:

- `date`
- `active_merchants`
- `installs`
- `uninstalls`
- `earnings_amount`

Collect one completed UTC day:

```bash
npm run merchgrid:collect -- --date YYYY-MM-DD
```

Build a weekly comparison through the final completed UTC day:

```bash
npm run merchgrid:weekly-review -- --through YYYY-MM-DD
```

Both commands print only the persisted artifact path and source statuses. The
artifacts contain aggregate evidence only.

After a saved daily-health or weekly-review artifact exists, run the workflow
lifecycle:

```bash
npm run merchgrid:daily-investigate -- --date YYYY-MM-DD --run-id RUN_ID
npm run merchgrid:weekly-recommend -- --through YYYY-MM-DD --run-id RUN_ID
npm run merchgrid:approve -- --run-id RUN_ID
npm run merchgrid:record-result -- --through YYYY-MM-DD --run-id RUN_ID
```

For new daily and weekly runs, `--run-id` is optional. If omitted, Buffr writes
the workflow run under a date-first folder such as:

```text
2026-08-25-merchgrid-daily-2026-08-21
2026-08-25-merchgrid-weekly-2026-08-21
```

The first date is the run date. The last date is the evidence-window date.

Use an external scheduler after UTC midnight for daily collection and after
Sunday closes for weekly review. This repository does not run an in-process
scheduler.

The weekly recommendation flow uses OpenAI-backed bounded modules, so local
`.env` also needs `OPENAI_API_KEY`. The command stops at the approval gate; it
never applies a real-world change by itself.

## Marketplace visibility operations

Marketplace visibility reviews turn sparse, aggregate-only evidence and local
context into a manual visibility recommendation. They never query private
marketplace providers or apply marketplace edits.

Run the single rolling lifecycle command after the requested weekly evidence
window is present in local snapshots or as a saved weekly-review artifact:

```bash
npm run marketplace:next-review -- \
  --profile merchgrid_shopify_app_store
```

`--profile` is the routing key that selects the marketplace workflow and its
configured context. Buffr reads the stable, lowercase kebab-case `productRef`
from that validated context; owners do not repeat it on the command line. The
internal product reference still separates product history and must remain
stable across reviews. Buffr also scans the persisted snapshots and selects the
newest completed UTC date for which every required source has complete data
across both adjacent seven-day windows. It combines that internally resolved
`through` date with the profile and product reference to generate the run id,
for example:

```text
2026-09-07-merchgrid_shopify_app_store-merchgrid-shopify-app
```

Do not supply or carry a run id between commands. Buffr finds the latest run by
exact `profile + productRef`, and retrying while the same complete evidence
window remains newest returns the same cycle without repeating owner prompts,
events, artifacts, or model work.
If an earlier invocation persisted an executable intermediate stage before a
transient failure, the same command resumes that run instead of abandoning it
or creating a competing cycle.

When a prior experiment plan is still awaiting an application decision, the
command interactively asks `Was it applied? (yes/no)` with no default. A `yes`
requires the UTC application date. Buffr validates that the new weekly result
window begins later, closes the prior run through M2 Results and M7, then starts
a separate next run through M6. A `no` records a stopped prior run and starts
the next run without fabricated result learning.

For an applied prior experiment, one fresh weekly artifact has two lineage
roles: it is the prior run's result evidence and the next run's baseline
evidence. The two immutable `run.json` records point to the same artifact, while
the next run receives only a bounded, validated M7 learning projection through
`previousRunRef` and `priorLearning`.

The command always loads product context from
`MERCHGRID_VISIBILITY_CONTEXT_PATH` and, when configured, public listing
context from `MERCHGRID_LISTING_CONTEXT_PATH`. This keeps the recurring command
to one routing option and prevents one review from accidentally pointing at a
different product's context. The product context contains only
the product-facing facts required for a sparse recommendation. Listing context
contains public observations such as headline, gallery count, trust signals,
and visual-review notes.

Start from the examples:

```text
docs/examples/merchgrid-visibility-context.example.json
docs/examples/merchgrid-listing-context.example.json
```

Do not put private dashboard pages, cookies, raw HTML, credentials, or merchant
data in either context file.

The weekly evidence prerequisite remains separate from marketplace review. Use
`merchgrid:collect` after each completed UTC date. You may run
`merchgrid:weekly-review` explicitly after two adjacent seven-day windows are
available; if that artifact is missing, `marketplace:next-review` attempts to
derive it from the already-persisted local snapshots. It does not call PostHog,
Fly, Shopify, or another provider to fill gaps. If snapshots are missing, the
command falls back to the newest earlier complete window. If no complete
fourteen-day window exists, it reports the exact bounded `source/YYYY-MM-DD`
entries missing from the latest candidate window; it does not create a partial
weekly artifact.

The rolling command records safe `rolling_review.*` events for cycle start,
prior-run discovery and evaluation, prior-learning selection, next-run
creation, and completion. `run.json` remains authoritative and `events.jsonl`
is its reviewable projection. The durable completion marker also prevents
duplicate cycle-level events on an ordinary retry.

If the brief is complete, zero metrics can still produce an `approval_wait`
recommendation. If required context is missing, the command stops with the
specific missing fields.

Marketplace M3 research is optional and disabled by default. Set
`MARKETPLACE_RESEARCH_ENABLED=true` only when the visibility workflow should
answer a concrete M2, M4, M5, M6, or M7 question with OpenAI hosted public web
search. The first pass is restricted to the configured official Shopify and
Etsy domains; one broader public-web pass is allowed only when official
evidence is insufficient. Sparse metrics alone do not trigger research.

Research receives one bounded question and returns structured citations to the
module that requested it. It never opens a private dashboard, uses an
authenticated marketplace session, or edits a listing. Call, time, token, and
cost controls are documented in `.env.example`, and the existing owner approval
boundary remains mandatory before any marketplace change. Buffr records the
owner's answer; the owner performs the external action manually.

Automated tests stay fully offline: they inject runners and hosted tools, use
synthetic `.example.test` URLs, fixed clocks, and temporary directories, and
require neither credentials nor a real `.env`. After a separately authorized
live validation, reviewers can inspect `run.json` as the source of record,
bounded search events in `events.jsonl`, and citation-only
`metadata.researchRefs` in `experiment-plan.json`.

## Etsy connector validation

The Etsy workflow engine design started around one Etsy seller: the project
owner. The first implementation phase proves engine inputs, pauses, state
transitions, evidence gates, and outputs before adding a terminal-chat adapter.
Terminal chat starts only after a mocked end-to-end lifecycle proves engine inputs, waits, resume behavior, outputs, traces, and persisted evidence.

The Etsy validation scaffold is exposed after building:

```bash
npm run etsy:validate
```

It validates Etsy configuration and is designed to perform one read-only listing
fetch. The default CLI currently injects an unavailable token provider, so a
live call stops with `configuration_failed` until an OAuth token provider is
implemented or injected. Tests supply fake tokens and HTTP responses.

The implemented Etsy connector is read-only. It can fetch listing and
transaction evidence and maps provider-specific listing responses into Buffr's
normalized contracts. It must not expose raw credential material to workflow
state or agent modules.

## Safety rules

Buffr is designed around explicit safety boundaries:

- Source adapters may read external data, but workflow modules consume
  normalized evidence contracts.
- The workflow engine never reads `.env`, raw API keys, OAuth client secrets,
  refresh tokens, or token file contents.
- Shopify Partner imports must be aggregate-only.
- Marketplace visibility context must contain product-facing and public listing
  observations only.
- M3 research uses read-only tools and must return cited evidence,
  limitations, and confidence.
- M3 can recommend whether its own research loop should continue or stop, but
  it cannot route the lifecycle.
- Experiment plans require owner approval.
- Etsy, Shopify, or marketplace listing changes remain manual.

## Design references

Current design and implementation references:

- `docs/superpowers/specs/2026-08-12-etsy-workflow-engine-design.md`
- `docs/superpowers/plans/2026-08-12-etsy-workflow-engine.md`
- `docs/superpowers/specs/2026-08-12-etsy-api-configuration-boundary-design.md`
- `docs/superpowers/specs/2026-08-20-merchgrid-business-review-aggregation-design.md`
- `docs/superpowers/specs/2026-08-23-merchgrid-workflow-integration-design.md`
- `docs/superpowers/specs/2026-08-23-marketplace-visibility-review-design.md`
- `docs/superpowers/specs/2026-08-24-marketplace-listing-visual-context-design.md`
- `docs/superpowers/specs/2026-08-24-marketplace-visibility-zero-data-review-design.md`
- `docs/superpowers/specs/2026-08-28-m3-marketplace-web-research-design.md`

Older docs under `docs/superpowers/specs/` and `docs/superpowers/plans/` may
describe archived aptkit work from before the Buffr reset. Treat current Buffr
files and tests as the source of truth when they differ.
