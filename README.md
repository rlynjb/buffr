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
- [Architecture at a glance](#architecture-at-a-glance)
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

| Workflow | Product surface | What it produces |
| --- | --- | --- |
| Etsy listing workflow | Etsy seller listing evidence | A listing experiment plan and later learning record |
| MerchGrid daily/weekly workflow | MerchGrid aggregate business and reliability metrics | Daily diagnosis, weekly recommendation, approval wait, and result learning |
| Marketplace visibility workflow | Sparse marketplace metrics plus curated product/listing context | A low-risk visibility experiment recommendation |

These workflows share the same core engine pattern. The source evidence differs,
but the lifecycle remains deterministic and contract-driven.

## Architecture at a glance

The approved architecture is:

**deterministic workflow orchestrator with bounded agentic workers**

```text
+--------------------------- external systems ----------------------------+
| Etsy API        PostHog        Fly metrics        Shopify CSV        web |
+-------------------------------+-----------------------------------------+
                                |
                                v
+--------------------------- adapters/connectors --------------------------+
| src/connectors/etsy/        src/connectors/merchgrid/        web tools   |
| map provider-specific data into Buffr evidence contracts                 |
+-------------------------------+-----------------------------------------+
                                |
                                v
+---------------------------- src/contracts -------------------------------+
| Zod schemas for evidence, workflow state, module outputs, experiments    |
+-------------------------------+-----------------------------------------+
                                |
                                v
+----------------------------- src/workflow -------------------------------+
| deterministic engine, routes, guards, wait/resume states, approvals      |
+-------------------------------+-----------------------------------------+
                                |
             +------------------+------------------+
             |                                     |
             v                                     v
+---------------------------+       +-------------------------------+
| src/agents/<role>/        |       | src/storage/                  |
| bounded M1-M7 judgment    |       | local JSON run/artifact files |
+---------------------------+       +-------------------------------+
```

The architecture combines a few standard patterns:

| Capability | Pattern name | Where to look |
| --- | --- | --- |
| Lifecycle control | Finite state machine / workflow orchestrator | `src/workflow/engine.ts`, `src/workflow/routes.ts` |
| Transition checks | Guards / schema validation | `src/workflow/guards.ts`, `src/contracts/` |
| External systems | Ports and adapters | `src/connectors/` |
| Persistence | Repository pattern | `src/storage/runs.ts`, `src/storage/metric-snapshots.ts` |
| LLM reasoning | Strategy-like specialist modules | `src/agents/<role>/` |
| Research detours | Bounded tool-use loop with circuit breakers | `src/agents/research/`, `src/workflow/routes.ts` |

The useful first-principles distinction is:

- Deterministic code handles things that must be repeatable, auditable, and
  safe: validation, routing, persistence, waits, approvals, and stop conditions.
- LLM modules handle judgment-heavy interpretation: context summaries,
  diagnoses, hypotheses, research interpretation, test plans, and learning.

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
one developer-controlled machine.

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
Real `.env` files and private source exports must stay out of git.

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
- `POSTHOG_PROJECT_ID`
- `POSTHOG_PERSONAL_API_KEY`
- `POSTHOG_BASE_URL`
- `FLY_ORG_SLUG`
- `FLY_ACCESS_TOKEN`
- `FLY_APP_NAME`
- `MERCHGRID_METRICS_DATA_DIR`
- `SHOPIFY_PARTNER_AGGREGATES_CSV_PATH`

Etsy connector validation uses the Etsy-related variables documented by the
Etsy configuration boundary and `.env.example`.

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

Validate Etsy connector configuration after building:

```bash
npm run etsy:validate
```

The Etsy connector is read-only. It fetches shop, listing, and transaction
evidence and maps provider-specific API responses into Buffr's normalized
contracts. It must not expose raw credential material to workflow state or agent
modules.

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
