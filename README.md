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
| Marketplace visibility workflow | `marketplace:*` commands | Sparse metrics plus curated product/listing context and optional public research | A low-risk visibility experiment recommendation with evidence references |

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

This framing borrows from Donella H. Meadows's *Thinking in Systems*: understand
the system by naming its purpose, boundary, stocks, flows, feedback, delays, and
decision rules—not only its boxes and files.

**Purpose**

Turn small, trusted evidence packets into one safe next experiment and then turn
the delayed result into reusable learning. The goal is not maximum automation;
it is better owner decisions with explicit uncertainty and provenance.

**System boundary**

Buffr includes its CLIs, connectors, contracts, source-pack pipeline, profile
services, workflow engine, agent modules, research adapter, local repositories,
and trace events. Provider systems, credential stores, schedulers, dashboards,
and the owner's manual marketplace edits remain outside the boundary.

**Stocks: state that accumulates or persists**

| Stock | Meaning | Source of record |
| --- | --- | --- |
| Daily metric snapshots | One normalized aggregate result per source and completed UTC day | `snapshots/<source>/<date>.json` |
| Daily and weekly reviews | Derived product-health evidence built from snapshots | `artifacts/daily-health/` and `artifacts/weekly-reviews/` |
| Workflow run state | Current stage, status, evidence references, module outputs, approval, and events | `workflow-runs/<run-id>/run.json` |
| Experiment plan | Reviewable M6 recommendation plus evidence and research references | `workflow-runs/<run-id>/experiment-plan.json` |
| Learning state | Post-experiment M2 result and M7 evaluation retained in the run | `workflow-runs/<run-id>/run.json` |

**Flows: what changes the stocks**

1. Collection reads approved aggregates from PostHog, Fly, and a Shopify CSV.
2. Connectors normalize source data and repositories persist daily snapshots.
3. Source-pack jobs derive daily health and adjacent seven-day weekly reviews.
4. Profile services qualify evidence and start or resume a workflow run.
5. The engine advances M1-M7, taking a bounded M3 detour when a concrete public
   research question is raised.
6. M6 writes a plan; the owner approves or rejects it and performs any change
   manually.
7. Later evidence re-enters through M2 Results, and M7 records the learning.

**Feedback loop and delays**

```text
observed evidence -> diagnosis -> hypothesis -> manual experiment
       ^                                           |
       |                                           v
future decision <- retained learning <- delayed result evidence
```

This is a human-mediated feedback loop. Its intentional delays are completed
UTC collection windows, adjacent weekly comparison windows, the experiment
wait, and the time required to gather qualified result evidence. Buffr does not
manufacture immediate feedback when the real signal has not arrived.

**Decision rules and leverage points**

- Zod schemas determine what may cross an untrusted boundary.
- Readiness functions determine whether evidence is complete enough to use.
- Workflow routes and guards determine legal state transitions.
- Research allowlists and call/time/token/cost caps constrain M3.
- Immutable completed snapshots prevent historical evidence from silently
  changing.
- The approval gate is the highest-leverage safety control: recommendations can
  accumulate, but only the owner can create a real-world marketplace change.

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

Main commands:

```bash
npm run marketplace:visibility-review -- --profile merchgrid_shopify_app_store --date YYYY-MM-DD --run-id RUN_ID --context artifacts/merchgrid/context/merchgrid-visibility-context.json --listing-context artifacts/merchgrid/context/merchgrid-listing-context.json
npm run marketplace:approve -- --run-id RUN_ID
npm run marketplace:reject -- --run-id RUN_ID --reason "Reason"
npm run marketplace:record-result -- --profile merchgrid_shopify_app_store --run-id RUN_ID --through YYYY-MM-DD
```

For new visibility reviews, `--run-id` is optional. If omitted, Buffr writes the
workflow run under a date-first folder such as:

```text
2026-08-25-merchgrid-visibility-2026-08-07-listing-context
```

Keep the printed run id because approval, rejection, and result commands still
need it.

The `--context` argument overrides `MERCHGRID_VISIBILITY_CONTEXT_PATH`. Use a
local curated JSON file with only the product-facing context required for a
sparse recommendation.

The optional `--listing-context` argument overrides
`MERCHGRID_LISTING_CONTEXT_PATH`. Use it for public marketplace listing
observations such as headline, gallery count, trust signals, and visual-review
notes.

Start from the examples:

```text
docs/examples/merchgrid-visibility-context.example.json
docs/examples/merchgrid-listing-context.example.json
```

Do not put private dashboard pages, cookies, raw HTML, credentials, or merchant
data in either context file.

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
gate remains mandatory before any marketplace change.

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
