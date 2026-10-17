# Buffr Repository Onboarding Guide

Buffr is a local, self-hosted evidence-to-decision work engine. It collects or
loads small evidence packets, validates them into stable internal contracts,
runs them through a deterministic workflow, and writes an experiment plan or
learning record for a human owner to review.

This README is **Stage 1** of a repository onboarding guide. It explains what
the repository contains, how its major parts relate, how to run the verified
local checks, and where to begin reading. It intentionally does not yet provide
the detailed execution traces, FODE lifecycle analysis, DDIA guarantee analysis,
or algorithm walkthroughs reserved for Stage 2.

## Guide status

| Item | Value |
| --- | --- |
| Repository type | Single-package TypeScript CLI/workflow application with a local file-backed data pipeline |
| Revision inspected | `main` at base commit `f0ac3b2` |
| Inspection date | 2026-10-17 |
| Runtime used for verification | Node.js `v22.23.1`, npm `10.9.8` |
| Commands actually run | `npm run typecheck`, `npm test`, `npm run build` |
| Verification result | Type-check and build passed; 49 test files and 404 tests passed |
| External commands not run | `marketplace:review` and `etsy:validate` because they require credentials, local evidence, and/or external calls |

Evidence labels used in this guide:

- **Verified** — directly supported by current source, configuration, tests, or
  commands run during this review.
- **Inferred** — a reasonable interpretation of the implementation, but not an
  explicit production requirement or maintainer statement.
- **Unknown** — not established by the repository.

## Table of contents

1. [Purpose and boundaries](#1-purpose-and-boundaries)
   - [What problem Buffr solves](#what-problem-buffr-solves)
   - [Capabilities and outputs](#capabilities-and-outputs)
   - [Actors and domain vocabulary](#actors-and-domain-vocabulary)
   - [Domain rules and invariants](#domain-rules-and-invariants)
   - [Inside and outside the repository](#inside-and-outside-the-repository)
2. [Repository and architecture map](#2-repository-and-architecture-map)
   - [Top-level map](#top-level-map)
   - [Runtime architecture](#runtime-architecture)
   - [System design versus software design](#system-design-versus-software-design)
   - [Major implementation areas](#major-implementation-areas)
   - [Requirements and architectural trade-offs](#requirements-and-architectural-trade-offs)
3. [Local development and first reading path](#3-local-development-and-first-reading-path)
   - [Prerequisites](#prerequisites)
   - [Install and verify](#install-and-verify)
   - [Configuration](#configuration)
   - [Run the application paths](#run-the-application-paths)
   - [Tests and fixtures](#tests-and-fixtures)
   - [CI and contribution conventions](#ci-and-contribution-conventions)
   - [Five files to read first](#five-files-to-read-first)
   - [Routes into the remaining subsystems](#routes-into-the-remaining-subsystems)
4. [Inspection scope and limitations](#4-inspection-scope-and-limitations)
5. [Stage 1 checkpoint](#5-stage-1-checkpoint)
6. [Stage 2: execution, data, and algorithms](#6-stage-2-execution-data-and-algorithms)
   - [Representative flow 1: marketplace review write path](#representative-flow-1-marketplace-review-write-path)
   - [Representative flow 2: read, retry, and resume path](#representative-flow-2-read-retry-and-resume-path)
   - [Representative flow 3: source metric normalization](#representative-flow-3-source-metric-normalization)
   - [Representative field trace](#representative-field-trace)
7. [FODE data lifecycle](#7-fode-data-lifecycle)
8. [DDIA data behavior and guarantees](#8-ddia-data-behavior-and-guarantees)
9. [Computational reasoning](#9-computational-reasoning)
10. [Stage 2 checkpoint](#10-stage-2-checkpoint)
11. [Stage 3: investigate, compare, and practice](#11-stage-3-investigate-compare-and-practice)
   - [Failure, security, and performance](#failure-security-and-performance)
   - [Design trade-offs](#design-trade-offs)
   - [Learning summary](#learning-summary)
   - [Practical onboarding path](#practical-onboarding-path)

---

## 1. Purpose and boundaries

### What problem Buffr solves

**Verified:** Buffr helps one local operator turn product and marketplace
evidence into a controlled experiment recommendation. The active owner-facing
workflow is the `marketplace:review` command defined in
[`package.json`](package.json#L6) and composed in
[`runMarketplaceVisibilityCli`](src/cli/marketplace-visibility.ts#L65).

The core problem is not merely “ask a model for advice.” Buffr separates four
responsibilities:

1. **Evidence acquisition:** adapters read aggregate metrics, curated JSON, a
   local CSV, or an external API.
2. **Normalization and validation:** Zod contracts convert those inputs into
   shapes Buffr is willing to trust.
3. **Lifecycle control:** TypeScript code decides which workflow stage may run,
   pause, resume, or stop.
4. **Bounded judgment:** deterministic functions and OpenAI-backed modules
   interpret already-normalized evidence inside the permitted stage.

The main product boundary is therefore:

```text
untrusted or curated inputs
        |
        v
validated Buffr evidence
        |
        v
deterministic workflow state machine
        |
        v
bounded recommendation and human approval
```

The human remains responsible for applying any real marketplace change. Buffr
records an application decision and later evidence, but the code does not edit
an Etsy listing, Shopify App Store listing, or other marketplace surface.

Terminal chat starts only after a mocked end-to-end lifecycle proves engine inputs, waits, resume behavior, outputs, traces, and persisted evidence.
No terminal-chat adapter is present in the current repository.

### Capabilities and outputs

| Capability | Status and evidence | Main output |
| --- | --- | --- |
| Marketplace visibility review | **Verified.** Public script and CLI route exist in [`package.json`](package.json#L9) and [`marketplace-visibility.ts`](src/cli/marketplace-visibility.ts#L65). | Current workflow summary plus persisted evidence and plan artifacts |
| MerchGrid evidence preparation | **Verified.** Three adapters feed a bounded fourteen-day window in [`marketplace-evidence-preparation.ts`](src/workflow/marketplace-evidence-preparation.ts#L30). | Daily snapshots and a weekly review artifact |
| Deterministic M1–M7 workflow | **Verified.** Stage transitions are owned by [`createWorkflowEngine`](src/workflow/engine.ts#L42), guards, and routes. | `run.json`, events, evidence projections, and an experiment plan |
| Structured agent execution | **Verified.** [`OpenAiAgentRunner`](src/agents/runner.ts#L90) invokes the OpenAI Agents SDK and revalidates structured output. | Validated module output and optional usage metadata |
| Optional public-web research | **Verified.** M3 can use a bounded hosted web-search tool when enabled in [`marketplace-config.ts`](src/agents/research/marketplace-config.ts#L41). | Cited research evidence and bounded search summaries |
| Etsy listing normalization | **Verified.** The connector client and mapper exist under [`src/connectors/etsy/`](src/connectors/etsy/). | `NormalizedListingEvidence` |
| Etsy connection validation command | **Partially usable.** The command exists, but its default token provider is deliberately unavailable; a real OAuth login flow is not implemented. See [`validate.ts`](src/connectors/etsy/validate.ts#L9). | A small JSON success result when a usable token provider is supplied |
| Hosted web application or API | **Not observed.** There is no HTTP server, frontend, or deployed service configuration in the tracked repository. | Not applicable |

The important persisted outputs are:

- a daily aggregate snapshot for each metric source and completed UTC date;
- daily and weekly review artifacts derived from those snapshots;
- operation-level JSONL events for evidence preparation and command execution;
- `run.json`, the authoritative state for one workflow run;
- evidence and event projections that make a run inspectable;
- `experiment-plan.json` after M6 produces a test plan.

### Actors and domain vocabulary

| Term | Plain-language meaning | Code anchor |
| --- | --- | --- |
| Owner | The local human operator who starts a review and decides whether a prior recommendation was applied. | [`createOwnerApplicationPrompt`](src/cli/marketplace-visibility.ts#L110) |
| Profile | A routing key selecting a supported marketplace workflow configuration. It is not the product-history identity by itself. | `MarketplaceVisibilityProfileSchema` in [`marketplace-visibility.ts`](src/contracts/marketplace-visibility.ts) |
| `productRef` | Stable internal identity used to keep one product's history separate from another's. It comes from validated context rather than normal CLI input. | [`runMarketplaceVisibilityCli`](src/cli/marketplace-visibility.ts#L75) |
| `through` | The completed UTC date ending the latest review window. It can be passed for controlled use or resolved from complete snapshots. | [`resolveLatestCompleteWeeklyThrough`](src/jobs/merchgrid-source-pack.ts) |
| Daily snapshot | One source's aggregate metrics for one completed UTC date. | `DailyMetricSnapshotSchema` in [`metrics.ts`](src/contracts/metrics.ts) |
| Weekly artifact | A derived comparison of two adjacent seven-day periods. | [`runWeeklyReview`](src/jobs/merchgrid-source-pack.ts) |
| Operation | One invocation of evidence preparation plus rolling review orchestration, identified deterministically. | [`marketplaceReviewOperationId`](src/storage/review-operations.ts) |
| Workflow run | One persisted recommendation/learning cycle with its own state and events. | `WorkflowRunStateSchema` in [`workflow.ts`](src/contracts/workflow.ts#L89) |
| M1–M7 | Context, metrics, research, diagnosis, hypothesis, test plan, and learning modules. M3 is a conditional side route rather than a mandatory linear step. | [`src/agents/`](src/agents/) and [`routes.ts`](src/workflow/routes.ts) |
| Projection | A readable copy derived from authoritative state, such as `events.jsonl` or `experiment-plan.json`. | [`JsonFileRunRepository.writeArtifacts`](src/storage/runs.ts#L140) |

The main relationships are:

```text
Profile + productRef
        |
        +---- identify product history
        |
through date + 3 sources x 14 completed days
        |
        +---- produce one weekly artifact
        |
weekly artifact + curated product/listing context
        |
        +---- produce workflow evidence
        |
workflow evidence + prior run state
        |
        +---- create/resume one deterministic workflow run
```

### Domain rules and invariants

These are product or correctness rules, not merely TypeScript type choices.

1. **The workflow engine owns lifecycle transitions.** Agent output can request
   or inform a route, but it cannot directly skip approval, wait, or evidence
   gates. See [`step`](src/workflow/engine.ts#L274),
   [`assertCanRunStage`](src/workflow/guards.ts#L25), and
   [`routes.ts`](src/workflow/routes.ts).
2. **Boundary data must validate at runtime.** Persisted state, connector
   outputs, context files, module outputs, dates, and CLI profile values pass
   through Zod schemas before use.
3. **Only completed UTC days qualify as daily evidence.** Current or future
   dates are rejected; past dates may be backfilled. Tests document this in
   [`metric-snapshots.test.ts`](src/tests/storage/metric-snapshots.test.ts#L100).
4. **A completed source/date snapshot is immutable.** An incomplete snapshot may
   be replaced after a successful retry, but a different complete snapshot for
   the same identity is rejected by
   [`JsonFileMetricSnapshotRepository`](src/storage/metric-snapshots.ts).
5. **Marketplace review requires bounded coverage.** The preparation service
   checks three sources across fourteen dates, representing two adjacent
   seven-day windows. It does not backfill unbounded history.
6. **Product identity must agree across state and evidence.** The run repository
   rejects persisted marketplace state whose profile, `productRef`, subject, or
   evidence identity disagrees. See
   [`hasConsistentMarketplaceIdentity`](src/storage/runs.ts#L234).
7. **Research is read-only and bounded.** Hosted search is optional, domain
   constrained on its first pass, and capped by tool-call and wall-clock limits.
8. **Credentials must not enter durable evidence or model input.** The workflow
   checks credential-like keys before persistence, and
   [`sanitizeModuleInput`](src/agents/runner.ts#L218) removes such keys before an
   agent call.
9. **Real-world mutation requires a person.** The workflow can wait for and
   record an explicit applied/not-applied decision; it does not apply the
   experiment itself.
10. **Current persistence assumes sequential local operation.** Snapshot files
    have a per-key filesystem lock, but workflow-run persistence does not provide
    a multi-process transaction or distributed lock.

### Inside and outside the repository

**Inside the runtime boundary:**

- CLI parsing and dependency composition;
- configuration loading;
- source adapters and provider-response normalization;
- runtime contracts;
- evidence aggregation;
- deterministic workflow orchestration;
- structured agent wrappers and prompts;
- local JSON/JSONL persistence;
- tests and local examples.

**Outside the runtime boundary:**

- PostHog, Fly metrics, Shopify Partner exports, Etsy, OpenAI, and hosted web
  search availability;
- real credentials and OAuth token acquisition;
- a human's marketplace edits;
- production scheduling, deployment, backups, monitoring, and account isolation;
- production traffic, data volume, latency, availability, and cost targets.

Those operational targets are **Unknown**. Passing local tests does not prove a
production deployment exists or that the system meets an unstated service-level
objective.

---

## 2. Repository and architecture map

### Top-level map

```text
buffr/
├── src/                     # Active TypeScript implementation and tests
│   ├── agents/              # M0 policy, M1-M7 modules, runner, research tool
│   ├── cli/                 # Owner-facing marketplace command
│   ├── connectors/          # Etsy, PostHog, Fly, CSV, and local-context adapters
│   ├── contracts/           # Zod schemas and inferred domain types
│   ├── core/                # Errors, environment loading, configuration helpers
│   ├── jobs/                # Daily collection and weekly review composition
│   ├── metrics/             # Aggregation, summaries, and evidence conversion
│   ├── storage/             # JSON/JSONL repositories
│   ├── tracing/             # Safe workflow-event construction
│   ├── workflow/            # State machine, routes, guards, review orchestration
│   └── tests/               # Unit, integration, end-to-end, and surface tests
├── artifacts/               # Tracked sample/history evidence and workflow runs
├── docs/                    # Historical designs, plans, prompts, and references
├── openspec/                # Spec-workflow configuration; no active change found
├── package.json             # Single npm package and command surface
├── package-lock.json        # npm lockfile
├── tsconfig.json            # Strict NodeNext/ES2022 TypeScript build
├── .env.example             # Configuration template; currently has known drift
├── TODO.md                  # Study/review checklist, not executable backlog state
└── AGENT_IMPLEMENTATION_MECHANISM_EXPLAINER.md
                              # Commit-scoped marketplace-review case study
```

Additional workspace directories need care:

- `dist/` and `node_modules/` are generated and ignored.
- `packages/` contains ignored compiled leftovers but no tracked source and is
  not declared as an npm workspace. **Verified:** the current repo is not an
  active monorepo despite those local directories.
- `.agents/`, `.claude/`, `.superpowers/`, and `.worktrees/` are development or
  agent-tooling areas, not Buffr runtime components.
- `docs/superpowers/` contains historical design and implementation records.
  Treat current source and tests as authoritative when those documents differ.
- `artifacts/` includes useful examples and smoke-run history, but historical
  run files are observations from earlier executions, not executable source.

### Runtime architecture

The boxes below are responsibilities inside one Node.js process unless marked
external. They are modules, not independently deployed services.

```text
BUILD TIME

[package.json + tsconfig.json + src/**/*.ts]
                    |
                    | npm run build (tsc)
                    v
               [dist/**/*.js]


RUNTIME: MARKETPLACE REVIEW

[Human owner]
    |
    | npm run marketplace:review -- --profile <profile>
    v
[CLI / composition root]
src/cli/marketplace-visibility.ts
    |
    +--> [local .env + process environment]
    |
    +--> [curated context JSON]
    |
    v
[MarketplaceReviewService]
src/workflow/marketplace-review.ts
    |
    +---------------- evidence path ----------------+
    |                                               |
    v                                               v
[Evidence preparation]                       [Operation events]
src/workflow/marketplace-evidence-            src/storage/review-operations.ts
preparation.ts                                      |
    |                                               v
    +--> [PostHog API] external               [events.jsonl]
    +--> [Fly metrics endpoint] external
    +--> [Shopify aggregate CSV] local
    |
    v
[Daily snapshot repository] ---> [weekly review artifact]
src/storage/metric-snapshots.ts  src/jobs/merchgrid-source-pack.ts
    |                                      |
    +------------------+-------------------+
                       v
              [Rolling review service]
              src/workflow/marketplace-rolling-review.ts
                       |
                       v
              [Deterministic engine]
              src/workflow/engine.ts
                       |
             +---------+----------+
             |                    |
             v                    v
      [M1-M7 modules]       [Run repository]
      src/agents/           src/storage/runs.ts
             |                    |
             | optional           +--> run.json (source of run state)
             v                    +--> evidence/*.json (projection)
      [OpenAI / hosted web]        +--> events.jsonl (projection)
      external                     +--> experiment-plan.json (projection)
                       |
                       v
              [Human approval boundary]
                       |
                       v
              [Manual marketplace change]
              outside Buffr
```

Most boundaries are synchronous `await` calls. No queue, worker process, event
broker, database, cache server, or scheduler was observed. JSONL “events” are
local audit projections, not a distributed event stream.

### System design versus software design

**System design** describes runtime responsibilities and communication:

- one local CLI process;
- external metrics/model providers;
- local files as persistence;
- a human approval boundary;
- synchronous orchestration with resumable workflow state.

**Software design** describes how those responsibilities are divided in code:

- contracts define allowed data shapes;
- connectors implement source-facing adapters;
- services orchestrate evidence and rolling reviews;
- the engine enforces lifecycle rules;
- module executors supply bounded domain reasoning;
- repository interfaces separate workflow logic from filesystem details.

The dependency direction is generally inward toward contracts and interfaces:
provider-specific details are mapped before workflow code consumes them. The CLI
is the composition root that chooses concrete filesystem repositories, adapters,
agent runner, research tool, and services in
[`createMarketplaceVisibilityDependencies`](src/cli/marketplace-visibility.ts#L137).

### Major implementation areas

| Area | Responsibility | Entry point or public seam | Main dependencies | Representative file |
| --- | --- | --- | --- | --- |
| `src/cli` | Parse owner input, load runtime configuration, wire concrete dependencies, print bounded output | `runMarketplaceVisibilityEntrypoint()` | Core config, connectors, workflow services, storage | [`src/cli/marketplace-visibility.ts`](src/cli/marketplace-visibility.ts) |
| `src/core` | Shared errors, `.env` loading, provider configuration, credential-key detection | `AppError`, `loadLocalEnvironment()`, config loaders | Node environment, `dotenv` | [`src/core/config.ts`](src/core/config.ts) |
| `src/contracts` | Define Buffr's runtime-validated product language | Zod schemas and inferred TypeScript types | `zod` | [`src/contracts/workflow.ts`](src/contracts/workflow.ts) |
| `src/connectors/merchgrid` | Collect and normalize PostHog, Fly, and Shopify Partner aggregate data | `MetricSourceAdapter` | HTTP client, provider config, metrics contracts | [`src/connectors/merchgrid/runtime.ts`](src/connectors/merchgrid/runtime.ts) |
| `src/connectors/marketplace` | Read and validate curated local product/listing context | Context loader functions | Filesystem, marketplace schemas | [`src/connectors/marketplace/local-context.ts`](src/connectors/marketplace/local-context.ts) |
| `src/connectors/etsy` | Call Etsy and map listing responses into normalized evidence | `EtsyOpenApiClient`, `createEtsyEvidenceRepository()` | Etsy config and token-provider port | [`src/connectors/etsy/mapper.ts`](src/connectors/etsy/mapper.ts) |
| `src/metrics` | Aggregate daily snapshots and derive review evidence | Coordinator and summary functions | Metrics contracts | [`src/metrics/coordinator.ts`](src/metrics/coordinator.ts) |
| `src/jobs` | Compose collection and weekly review operations | `runDailyCollection()`, `runWeeklyReview()` | Adapters, snapshot store, metrics functions | [`src/jobs/merchgrid-source-pack.ts`](src/jobs/merchgrid-source-pack.ts) |
| `src/workflow` | Enforce states, routes, evidence gates, rolling-cycle rules, and command-level orchestration | `createWorkflowEngine()` and review service factories | Contracts, module executor, repository ports | [`src/workflow/engine.ts`](src/workflow/engine.ts) |
| `src/agents` | Build module instructions, sanitize input, execute deterministic or model-backed modules, and validate outputs | `AgentRunner`, module executors | OpenAI Agents SDK, prompts, contracts | [`src/agents/runner.ts`](src/agents/runner.ts) |
| `src/storage` | Persist snapshots, operations, runs, and projections as local files | Repository interfaces and JSON implementations | Node filesystem, contracts | [`src/storage/runs.ts`](src/storage/runs.ts) |
| `src/tracing` | Construct safe, validated workflow events | `createWorkflowEvent()` | Workflow contracts and credential guard | [`src/tracing/events.ts`](src/tracing/events.ts) |
| `src/tests` | Specify domain rules and verify boundaries with fakes and temporary directories | Vitest suites | All active subsystems | [`src/tests/workflow/marketplace-review.e2e.test.ts`](src/tests/workflow/marketplace-review.e2e.test.ts) |
| `src/index.ts` | Placeholder package start target | Top-level script | None | [`src/index.ts`](src/index.ts) |

### Requirements and architectural trade-offs

Using the requirements-first style from *System Design Interview*, the observed
design can be summarized as follows.

| Observed requirement | Architectural response | Benefit | Cost or limit |
| --- | --- | --- | --- |
| One owner should run one review command | Synchronous CLI façade over existing subsystems | Simple operation and immediate error reporting | End-to-end latency includes collection and model calls |
| Recommendations must be reviewable | Human-readable JSON and JSONL artifacts | Easy local inspection and debugging | Weak ad hoc querying compared with a database |
| Retries should reuse completed work | Deterministic identities and immutable completed snapshots | Sequential retries converge on existing records | External calls can repeat after a crash before state is saved |
| Models must not control business state | TypeScript state machine and runtime schemas | Explicit, testable lifecycle rules | More orchestration code and contracts to maintain |
| Sensitive provider details must stay bounded | Aggregation, credential-key guards, sanitized model input | Reduces accidental persistence and prompt exposure | Key-name filtering is not a complete data-loss-prevention system |
| The first deployment is local and single-owner | Filesystem repositories instead of a database | Low operational complexity | Concurrent writers, remote access, indexing, and HA are unsupported |

Known capacity numbers, read/write ratios, latency objectives, availability
targets, retention requirements, and cost budgets are **not specified**. Do not
assume the current design was load-tested because it has deterministic IDs or
local locks.

---

## 3. Local development and first reading path

### Prerequisites

**Verified repository requirements:**

- npm, because `package-lock.json` is the only lockfile;
- a Node.js runtime that supports ESM, `node:readline/promises`, built-in
  `fetch`, and the emitted ES2022 code;
- filesystem access for local snapshots and workflow artifacts;
- credentials only for commands that contact external systems.

The repository does not declare `engines`, `.nvmrc`, or `.node-version`.
`@types/node` targets Node 20, but that is a compile-time type package rather
than a formal runtime guarantee. **Inferred:** Node 20 or newer is the safest
default until maintainers pin a version. Verification for this documentation
pass used Node `v22.23.1`.

### Install and verify

Run commands from the repository root.

```bash
npm ci
```

`npm ci` installs exactly the locked dependency graph and replaces the existing
`node_modules/` directory. It was **inspected but not run** during this pass
because dependencies were already present.

```bash
npm run typecheck
```

Runs `tsc --noEmit`. **Actually run:** passed on 2026-10-17.

```bash
npm test
```

Runs Vitest once. **Actually run:** 49 files and 404 tests passed on
2026-10-17. These tests use fakes and temporary directories for the main
integration paths; this result does not validate live provider credentials.

```bash
npm run build
```

Runs `tsc` and emits ESM JavaScript under ignored `dist/`. **Actually run:**
passed on 2026-10-17. Build before invoking scripts that execute `dist/*.js`.

```bash
npm run test:watch
```

Starts Vitest in watch mode for local iteration. This command was inspected but
not run during the documentation pass.

### Configuration

Do not inspect, print, or commit the real `.env`. The repository's `.gitignore`
excludes `.env`, `.env.local`, local Etsy tokens, raw provider exports,
`node_modules/`, and `dist/`.

The marketplace CLI calls
[`loadLocalEnvironment`](src/core/local-env.ts#L11), which reads a root `.env`
without replacing variables already supplied by the shell. Active marketplace
configuration includes:

| Purpose | Runtime key |
| --- | --- |
| Snapshot/artifact root | `MERCHGRID_METRICS_DATA_DIR` |
| Product context | `MERCHGRID_VISIBILITY_CONTEXT_PATH` |
| Optional listing context | `MERCHGRID_LISTING_CONTEXT_PATH` |
| OpenAI execution | `OPENAI_API_KEY`; optional `OPENAI_MODEL` |
| PostHog | `POSTHOG_PROJECT_ID`, `POSTHOG_PERSONAL_API_KEY`; optional `POSTHOG_API_BASE_URL` |
| Fly metrics | `FLY_ACCESS_TOKEN`, `FLY_APP_NAME`, `FLY_METRICS_URL` |
| Shopify Partner CSV | `SHOPIFY_PARTNER_CSV_PATH` |
| Optional M3 research | `MARKETPLACE_RESEARCH_ENABLED`, `MARKETPLACE_RESEARCH_ALLOWED_DOMAINS`, `MARKETPLACE_RESEARCH_SEARCH_CONTEXT`, `MARKETPLACE_RESEARCH_MODEL`, and the four `MARKETPLACE_RESEARCH_MAX_*` limits |

The Etsy validation path reads `ETSY_VALIDATE_LISTING_ID`, `ETSY_API_KEY`,
`ETSY_OAUTH_CLIENT_ID`, `ETSY_OAUTH_REDIRECT_URI`, `ETSY_OAUTH_SCOPES`, and
`ETSY_TOKEN_STORAGE_PATH` directly from `process.env`.

#### Known configuration documentation drift

**Verified conflict:** [`.env.example`](.env.example) does not currently match
all active runtime names.

| `.env.example` entry | Runtime implementation |
| --- | --- |
| `POSTHOG_BASE_URL` | Reads `POSTHOG_API_BASE_URL` |
| `FLY_ORG_SLUG` | Not consumed by current source |
| No `FLY_METRICS_URL` example | `FLY_METRICS_URL` is required |
| `SHOPIFY_PARTNER_AGGREGATES_CSV_PATH` | Reads `SHOPIFY_PARTNER_CSV_PATH` |
| No Etsy entries | Etsy config loader requires six Etsy-related values plus the validation listing ID |

The marketplace command auto-loads `.env`; the Etsy validation entry point does
not call `loadLocalEnvironment()`. Export Etsy variables in the shell unless
that entry point is changed. Treat implementation keys as authoritative until
the example file is corrected.

Example context shapes live in [`docs/examples/`](docs/examples/). Current
tracked artifacts also contain concrete context and run examples, but inspect
them as historical evidence rather than generic fixtures.

### Run the application paths

#### Marketplace review

After building and configuring the required sources:

```bash
npm run marketplace:review -- \
  --profile merchgrid_shopify_app_store
```

The CLI also accepts `--through YYYY-MM-DD` for a controlled date; otherwise it
resolves the newest complete adjacent-window date from stored snapshots.

This command can:

- call PostHog, Fly, and OpenAI;
- read the configured Shopify CSV and context JSON;
- prompt about a prior experiment;
- write snapshots, artifacts, operation events, and workflow state.

It was not run during this documentation pass. Use test fixtures when learning
the flow unless you intentionally want live external calls and durable local
writes.

#### Etsy validation

```bash
npm run etsy:validate
```

This executes the built Etsy validation entry point. It was not run. The default
token provider throws an unavailable-connector error, so the command is not a
complete local OAuth login workflow. Tests inject a token provider and fake
network responses to verify the connector boundary.

#### Scaffold start target

```bash
npm start
```

This currently runs [`dist/index.js`](src/index.ts) and prints
`buffr workflow engine scaffold loaded`. It does not start a server or the
marketplace workflow. Use it only as a package-loading smoke target.

### Tests and fixtures

Tests are under [`src/tests/`](src/tests/) and follow the implementation's
subsystem names. Useful categories are:

- **Contract tests:** schema acceptance, rejection, and cross-field invariants.
- **Connector tests:** provider parsing, safe failures, and normalization.
- **Storage tests:** immutable snapshots, atomic file replacement, corrupt data,
  run identity, and local lock behavior.
- **Workflow tests:** legal transitions, approval, waits, research detours,
  retries, and rolling-cycle behavior.
- **End-to-end tests:** compose real local services with fake external adapters
  and temporary storage.
- **Package-surface tests:** pin the intended public npm command names.

Start with
[`marketplace-review.e2e.test.ts`](src/tests/workflow/marketplace-review.e2e.test.ts#L19).
It demonstrates the complete local composition with one missing source/date,
artifact reuse on retry, deterministic run identity, safe events, and a workflow
ending at the approval boundary.

Fixtures and examples have different roles:

- [`src/tests/fixtures/`](src/tests/fixtures/) contains reusable test data.
- [`docs/examples/`](docs/examples/) contains copyable context examples.
- [`artifacts/`](artifacts/) contains tracked operational and smoke-run history.
  Do not assume every artifact represents the latest successful behavior.

### CI and contribution conventions

**No tracked CI or deployment configuration was observed.** There is no
`.github/workflows/`, Dockerfile, Compose file, or deployment manifest. Local
quality commands are therefore the only verified automated gate in this
repository.

Observed implementation conventions:

- strict TypeScript with ESM and `NodeNext` module resolution;
- `.js` suffixes in TypeScript imports so emitted ESM resolves correctly;
- Zod schemas at persistence and external-data boundaries;
- `AppError` codes for expected application failures;
- dependency injection for HTTP, time, agent execution, prompts, and storage in
  tests;
- temporary directories rather than checked-in output for storage tests;
- deterministic IDs for retryable local operations;
- credential filtering before model input and durable event/state writes;
- tests live under `src/tests/`, not beside implementation files.

No tracked `CONTRIBUTING.md`, code of conduct, security policy, license file, or
formatter configuration was found. Commit-message history uses short
conventional-style prefixes such as `docs:`, `chore:`, and `feat:`, but no
repository policy formally requires them.

One documentation defect is worth knowing before onboarding: the tracked
[`src/agents/core/README.md`](src/agents/core/README.md#L41) contains accidental
patch text and an obsolete copy of `runner.ts`. Read
[`src/agents/core/policy.ts`](src/agents/core/policy.ts) and the actual
[`src/agents/runner.ts`](src/agents/runner.ts) instead.

### Five files to read first

Read these in order. Each file should answer one concrete question.

1. [`src/contracts/README.md`](src/contracts/README.md)
   **Question:** What evidence, workflow state, and module outputs does Buffr
   consider valid? Use it as vocabulary, but verify details against schemas.
2. [`src/cli/marketplace-visibility.ts`](src/cli/marketplace-visibility.ts)
   **Question:** What does the owner command accept, and which concrete runtime
   components does it wire together?
3. [`src/workflow/marketplace-review.ts`](src/workflow/marketplace-review.ts)
   **Question:** Where is the boundary between evidence preparation, operation
   tracing, and rolling workflow execution?
4. [`src/workflow/engine.ts`](src/workflow/engine.ts)
   **Question:** Which component owns legal stage transitions, waits, approval,
   research side routes, and resume behavior?
5. [`src/storage/runs.ts`](src/storage/runs.ts)
   **Question:** What is authoritative, what is projected for inspection, and
   what does a filesystem write actually guarantee?

Then read the matching end-to-end test to check your mental model:
[`src/tests/workflow/marketplace-review.e2e.test.ts`](src/tests/workflow/marketplace-review.e2e.test.ts).

### Routes into the remaining subsystems

After the first five files, choose a route based on the problem you are
investigating.

| If you need to understand… | Read this route |
| --- | --- |
| Missing or reused daily metrics | `contracts/metrics.ts` → `connectors/merchgrid/source.ts` → provider adapter → `storage/metric-snapshots.ts` → its tests |
| Weekly aggregation | `metrics/coordinator.ts` → `metrics/summaries.ts` → `jobs/merchgrid-source-pack.ts` → source-pack tests |
| Product/listing context | `docs/examples/*.json` → `connectors/marketplace/local-context.ts` → `contracts/marketplace-visibility.ts` |
| Rolling review history | `workflow/marketplace-rolling-review.ts` → `workflow/marketplace-visibility-profile.ts` → rolling-review tests |
| A workflow route or unexpected wait | `contracts/workflow.ts` → `workflow/guards.ts` → `workflow/routes.ts` → `workflow/engine.ts` |
| Model input/output behavior | `agents/core/policy.md` → module prompt → module wrapper → `agents/runner.ts` → agent tests |
| Hosted web research | `agents/research/marketplace-config.ts` → `hosted-web-search.ts` → `research/agent.ts` → research tests |
| Etsy normalization | `connectors/etsy/client.ts` → `mapper.ts` → `repository.ts` → Etsy connector tests |
| Persisted evidence or a corrupt run | `storage/runs.ts` or `storage/metric-snapshots.ts` → corresponding storage tests → relevant artifact directory |
| Why a public command changed | `src/tests/package-surface.test.ts` → current `package.json` → historical design under `docs/superpowers/` |

---

## 4. Inspection scope and limitations

### Areas inspected

- root manifest, lockfile, TypeScript configuration, ignore rules, environment
  example, current README, TODO, and recent Git history;
- active entry points and runtime composition;
- representative contracts, workflow orchestration, storage repositories,
  connectors, metrics aggregation, agent runner, research configuration, and
  tracing;
- subsystem READMEs and representative historical design records;
- test inventory plus representative unit, integration, end-to-end, storage,
  CLI, and package-surface tests;
- tracked artifact structure without exposing secret values;
- presence or absence of CI, deployment, runtime-version, and contribution files.

### Areas not exhaustively inspected

- every Zod field and every route branch;
- every prompt or historical design/plan document;
- every tracked workflow artifact and smoke-run event;
- ignored compiled leftovers under `packages/`;
- dependency implementation inside `node_modules/`;
- real `.env` values, local token files, or raw provider exports;
- live provider behavior, production deployment state, production load, billing,
  or operational dashboards.

### Access and evidence limitations

- Repository access was local and complete for tracked files.
- Network providers were intentionally not called.
- The test suite verifies behavior with fakes and local temporary files; it does
  not prove live PostHog, Fly, Shopify, Etsy, OpenAI, or web-search integration.
- Historical docs sometimes describe proposed states. Current source, tests, and
  the package command surface take precedence when they conflict.
- The current README revision itself is a documentation change after the base
  commit named at the top of this guide.

For a deep, commit-specific explanation of the single marketplace-review
command, see
[`AGENT_IMPLEMENTATION_MECHANISM_EXPLAINER.md`](AGENT_IMPLEMENTATION_MECHANISM_EXPLAINER.md).
That document is a case study, not the canonical current-state repository map.

---

## 5. Stage 1 checkpoint

### Comprehension questions

1. How would you explain the difference between an operation, a weekly artifact,
   and a workflow run, and which identity fields connect them?
2. Why can an agent module influence a recommendation without owning the next
   workflow stage or applying a marketplace change?
3. If `experiment-plan.json` and `run.json` appeared to disagree, which would you
   inspect as the source of workflow truth, and which code writes both files?

### Most important unknowns

- Which Node.js version should maintainers formally support?
- Is Buffr intended to remain a sequential local tool, or is hosted multi-user
  operation an upcoming requirement?
- What production traffic, latency, availability, retention, backup, and model
  cost objectives exist, if any?
- Which tracked artifacts are canonical examples versus debugging history?
- Should CI enforce the already-passing type-check, test, and build commands?
- Who owns correcting `.env.example` and the corrupted core-agent README?

---

## 6. Stage 2: execution, data, and algorithms

Stage 2 connects the repository map to actual execution. The examples below use
the marketplace review because it crosses the CLI, connectors, contracts,
aggregation, workflow engine, agent modules, and storage. They do not represent
every Etsy or standalone module path.

### Representative flow 1: marketplace review write path

**Trigger:** The owner runs:

```bash
npm run marketplace:review -- --profile merchgrid_shopify_app_store
```

The main path is:

1. [`runMarketplaceVisibilityCli`](src/cli/marketplace-visibility.ts#L65)
   accepts only `review`, requires `--profile`, and optionally accepts
   `--through`.
2. The composition root resolves the context path from configuration and calls
   [`loadRollingMarketplaceVisibilityContext`](src/connectors/marketplace/local-context.ts#L22)
   to obtain a validated `productRef`.
3. The CLI calls the `MarketplaceReviewService` with `profile`, `productRef`,
   `through`, and local context paths. The service derives a deterministic
   operation ID and records `marketplace_review.started` in
   [`marketplace-review.ts`](src/workflow/marketplace-review.ts#L47).
4. [`MarketplaceEvidencePreparationService.prepare`](src/workflow/marketplace-evidence-preparation.ts#L67)
   validates that `through` is a completed UTC date, derives the fourteen-day
   window, and loads existing snapshots into a `Map` keyed by `source/date`.
5. For each date and each of the three sources, complete snapshots are reused.
   Missing or non-complete snapshots invoke
   [`runDailyCollection`](src/jobs/merchgrid-source-pack.ts#L146), which delegates
   to the PostHog, Fly, or Shopify CSV adapter.
6. If any source/date remains incomplete, preparation stops with a bounded
   `Missing weekly metric snapshots ...` error. It does not create a weekly
   artifact from incomplete coverage.
7. If coverage is complete, the service loads or generates the weekly artifact,
   loads curated context JSON, and calls
   [`buildRollingVisibilityEvidence`](src/workflow/marketplace-visibility-profile.ts#L145).
8. [`createMarketplaceRollingReviewService.nextReview`](src/workflow/marketplace-rolling-review.ts#L123)
   validates identity/evidence agreement, derives the cycle run ID, checks for
   an existing cycle, and otherwise resolves the previous product run.
9. The rolling service starts the workflow through
   `engine.startMarketplaceVisibility()` and repeatedly calls `engine.step()`
   while the current stage is one of the new-review stages. The engine persists
   state after transitions and routes M3 as a conditional side route.
10. The run repository writes `run.json` plus readable evidence, event, and plan
    projections. The CLI prints bounded run details; it does not print provider
    payloads, credentials, or full prompts.

The main state change is the creation or update of a workflow run. The source
snapshots and weekly artifact are supporting data products; the run state is what
records the lifecycle position and validated module outputs.

**Error path:** The review façade tracks whether it is in evidence preparation or
workflow execution. On failure it attempts to append
`marketplace_review.failed` with the stage and error code before rethrowing. If
that failure event cannot be persisted, it raises a storage error describing
both failures. See [`marketplace-review.ts`](src/workflow/marketplace-review.ts#L96).

### Representative flow 2: read, retry, and resume path

The command is also a read path because it first reads local state to decide
whether it is starting, resuming, or closing a cycle.

```text
requested profile/productRef/through
              |
              v
load exact cycle run ID
              |
       +------+------+
       |             |
    exists         absent
       |             |
       v             v
advance existing   scan product history
cycle if legal     for prior run
       |             |
       +------+------+
              v
       resolve owner decision
              |
       +------+------+
       |             |
   not applied     applied
       |             |
       v             v
   stop run      wait for later evidence,
                 then evaluate through M2/M7
```

1. `findExistingCycle()` calls `history.load(prepared.cycleRunId)`. A missing
   exact cycle is normal; another storage error is not hidden.
2. An existing legal cycle is passed to `advanceNewReview()`. This makes a
   sequential retry resume from persisted stage/status instead of creating a
   competing run.
3. When no current cycle exists, `findLatestByProduct()` scans run directories,
   parses each `run.json`, filters exact `profile + productRef`, and chooses the
   newest matching run. This is a full local-history scan, not an indexed query.
4. If the previous run is awaiting an application decision, the owner must answer
   explicitly. `yes` requires a non-future UTC application date; `no` records a
   stopped run without fabricating later learning.
5. For an applied run with later evidence,
   `resumeWithExperimentResults()` stores result evidence, then the engine
   advances M2 Results and M7 Learning. Bounded prior learning is passed into the
   next run through `previousRunRef` and `priorLearning`.
6. The engine serializes conflicting application decisions with an in-memory
   per-run promise lock. The test
   [`engine.test.ts`](src/tests/workflow/engine.test.ts#L268) proves one concurrent
   decision wins and the other is rejected after the state changes.

**Small example:** If the current run is at `approval_wait`, two callers submit
`applied` and `not_applied` at the same time. The first operation acquires the
process-local lock, persists either `experiment_wait` or `stopped`, and the
second reloads the changed state and receives `route_not_allowed`. This is a
correctness guarantee within one engine process, not a distributed lock.

### Representative flow 3: source metric normalization

This flow shows how provider-shaped data becomes a review metric.

1. The PostHog adapter builds an aggregate query and parses only approved event
   names into numeric metric keys in
   [`posthog.ts`](src/connectors/merchgrid/posthog.ts#L14).
2. The source adapter returns a `DailyMetricSnapshot` with `source`, completed
   UTC `date`, collection status, aggregate `metrics`, and notes. Raw provider
   payloads are not the workflow contract.
3. [`buildWeeklyBusinessReview`](src/metrics/summaries.ts#L77) validates that each
   period has exactly seven consecutive dates and that the two periods are
   adjacent.
4. `buildWeeklyPeriod()` sums ordinary count metrics across complete snapshots,
   preserves the final day's `active_merchants` value, and derives rates such as
   `scan_completion_rate` and `error_rate` from their numerator and denominator.
5. The weekly result is persisted as a derived artifact and converted into
   workflow evidence. The workflow consumes that evidence rather than querying
   PostHog directly.

The original daily counts remain the source records. The weekly rate is a stored
derived value, refreshed only when the weekly artifact is generated; if the
artifact already exists, the preparation service reuses it. The code does not
show a background refresh or change-data-capture mechanism.

### Representative field trace

Trace `scan_completion_rate` through the system:

```text
PostHog approved events
  -> posthog adapter counts scan_started / scan_completed
  -> daily snapshot metrics
  -> buildWeeklyPeriod().deriveRate()
  -> weekly artifact aggregateMetrics
  -> toMerchGridReviewEvidence()
  -> MarketplaceVisibilityEvidence
  -> M2/diagnosis/test-plan modules
  -> run.json and experiment-plan.json projections
```

At the provider seam, event names are filtered and mapped to approved metric
keys. At the weekly transformation seam, the rate is calculated as
`scan_completed_count / scan_started_count` only when both values are available;
otherwise coverage and limitations describe why it is unavailable. The rate is
therefore not a read-time join and not an independent source of truth: it is a
persisted projection derived from daily snapshots. Its refresh mechanism is
explicitly the weekly-artifact generate/reuse branch in
[`marketplace-evidence-preparation.ts`](src/workflow/marketplace-evidence-preparation.ts#L150).

The identity field follows a separate path: local context validates `productRef`,
the CLI passes it unchanged into the operation, identity, evidence, and run-ID
constructors, and repositories reject mismatches. It is validated and reused,
not renamed or numerically transformed.

Areas these flows do not cover include Etsy's injected token-provider path,
standalone M1–M7 module behavior, every research-limit branch, and the details
of OpenAI provider responses. Explore those through the routes listed in
[Routes into the remaining subsystems](#routes-into-the-remaining-subsystems).

---

## 7. FODE data lifecycle

FODE's lifecycle is useful here as a set of responsibilities rather than a claim
that Buffr is a large data platform.

| Lifecycle stage | Repository mapping | Status |
| --- | --- | --- |
| Generation | PostHog events, Fly metrics, Shopify aggregate CSV, curated context JSON, Etsy API responses, and optional public-web results originate outside or at the local boundary. | **Changed/depends on** external providers and owner-curated inputs |
| Ingestion | CLI configuration and connector adapters load files or call HTTP endpoints. `MetricSourceAdapter` turns each source response into a `DailyMetricSnapshot`. | **Changed** by active connector and CLI code |
| Storage | JSON snapshots, weekly artifacts, workflow runs, and JSONL events are written under the configured local data directory. | **Changed**; no database or remote warehouse observed |
| Transformation | Runtime schemas validate data; metric summaries aggregate seven-day periods; `deriveRate()` produces rates; workflow modules transform evidence into diagnosis, hypothesis, and test-plan outputs. | **Changed** |
| Serving | The CLI prints a bounded summary; humans inspect `run.json`, evidence, events, and `experiment-plan.json`; later runs consume prior state. | **Changed** |

Lifecycle undercurrents:

- **Security:** credentials are loaded at the boundary, filtered from agent input,
  and rejected from durable event/state data by key-based guards. Authentication
  and authorization for a deployed multi-user system are not observed.
- **Data management:** source/date identity, UTC completion, schema parsing,
  evidence references, and artifact lineage make local records understandable.
  Retention, backup, deletion, and ownership policy are unknown.
- **DataOps:** tests, bounded error events, fixture adapters, and inspectable
  artifacts support local operations. There is no hosted scheduler, alerting,
  dashboard, or data-quality service.
- **Data architecture:** provider-specific data is normalized behind contracts;
  daily snapshots are source records for the local review pipeline, while weekly
  artifacts and plans are derived products.
- **Orchestration:** the workflow engine and rolling-review service coordinate
  synchronous steps, waits, resume behavior, and the M3 side route.
- **Software engineering:** dependency injection, schemas, repositories, fakes,
  and tests create seams that can be exercised without live providers.

Operational application data and analytical data are intentionally small and
mixed: daily and weekly aggregates are analytical-style evidence, while workflow
state, owner decisions, and plans are operational application state. No ML
training pipeline, streaming system, batch scheduler, or warehouse is observed.

---

## 8. DDIA data behavior and guarantees

The following mechanisms are present in the code. Guarantees are deliberately
limited to what the implementation supports.

### Data model and access patterns

- **Evidence:** Zod schemas define stable internal records instead of exposing
  provider payloads to the workflow. The main access keys are `source/date` for
  snapshots, `through` for weekly artifacts, and deterministic IDs for operation
  and run records.
- **Guarantee:** callers can validate identity and shape at module boundaries.
- **Not guaranteed:** flexible ad hoc queries, relational joins, or indexed
  historical search.
- **Failure mode:** a schema-incompatible persisted file or provider response
  becomes a validation/storage error.
- **Vocabulary:** normalized model, access pattern, composite identity,
  contract boundary.

### Filesystem storage and retrieval

- **Where:** `JsonFileMetricSnapshotRepository`,
  `JsonFileRunRepository`, and `JsonFileReviewOperationEventRepository`.
- **Guarantee:** individual JSON replacements use temporary files followed by
  rename, so a reader normally sees an old complete file or a new complete file.
  Snapshot identity and run state are revalidated when read.
- **Not guaranteed:** atomicity across multiple files, external calls, or an
  entire marketplace review command; replication, fsync durability, and backup
  recovery are not implemented.
- **Failure mode:** the process can leave snapshots or an artifact persisted while
  the later workflow step has not completed.
- **Vocabulary:** atomic replacement, crash consistency, source of truth,
  projection, multi-record transaction.

### Materialized outputs and derived data

- **Where:** daily snapshots feed weekly review artifacts; `run.json` feeds
  `evidence/*.json`, `events.jsonl`, and `experiment-plan.json`.
- **Guarantee:** later review steps can reuse small local records without
  re-querying every provider, and humans can inspect projections.
- **Not guaranteed:** automatic invalidation or refresh after an upstream source
  changes. A reused weekly artifact may reflect the data available when it was
  generated.
- **Failure mode:** a stale derived artifact can be reused unless the selected
  `through` identity changes or the artifact is removed/rebuilt.
- **Vocabulary:** materialized view, derived data, lineage, refresh policy.

### Idempotency and retry behavior

- **Where:** `marketplaceReviewOperationId()`, `rollingVisibilityRunId()`,
  immutable completed snapshots, existing-cycle lookup, and artifact reuse.
- **Guarantee:** ordinary sequential retries with the same profile, product, and
  through date converge on the same operation/run/artifact identities and avoid
  repeating already-persisted workflow transitions.
- **Not guaranteed:** exactly-once provider or model calls. A crash after a call
  succeeds but before the corresponding durable state is saved can cause a retry
  to call it again. Operation-level events may also be appended by repeated
  command attempts.
- **Failure mode:** repeated external charges, latency, or provider-side effects
  are possible if an external call is not itself idempotent.
- **Vocabulary:** idempotency key, at-least-once side effect, retry convergence,
  exactly-once illusion.

### Transactions and concurrency control

- **Where:** snapshot filesystem locks and the in-memory
  `withExperimentApplicationLock()` promise chain in the workflow engine.
- **Guarantee:** concurrent saves for one source/date are serialized locally;
  concurrent experiment-application decisions in one engine process are
  serialized and checked against the latest state.
- **Not guaranteed:** a transaction spanning snapshots, artifacts, events, run
  state, model calls, or multiple processes. The lock is not distributed.
- **Failure mode:** two CLI processes targeting the same run root can race on
  workflow read-modify-write operations or event appends.
- **Vocabulary:** critical section, optimistic state check, process-local lock,
  distributed coordination, isolation boundary.

### Serialization and schema evolution

- **Where:** Zod schemas parse persisted JSON and module output; Markdown prompts
  are loaded beside source or through a source-tree fallback.
- **Guarantee:** malformed or identity-inconsistent state fails visibly instead of
  silently entering the next stage.
- **Not guaranteed:** backward-compatible migrations, explicit schema versions,
  or a rolling deployment protocol for old files.
- **Failure mode:** changing a required field or enum can make previously written
  artifacts unreadable even though TypeScript compiles.
- **Vocabulary:** serialization contract, runtime validation, schema evolution,
  migration, compatibility.

### Observability and recovery

- **Where:** validated workflow events, operation JSONL, run events, and readable
  artifacts; errors use `AppError` codes.
- **Guarantee:** a local operator can inspect what stage and artifact references
  were persisted, and a sequential command can often resume from `run.json`.
- **Not guaranteed:** centralized logs, metrics, alerts, trace correlation across
  providers, automatic retry queues, or disaster recovery.
- **Failure mode:** a filesystem or provider failure may be visible only through a
  CLI error and local event file; no hosted observer is notified.
- **Vocabulary:** audit trail, operational projection, recovery point,
  observability gap.

### Not observed

Replication, replica lag, partitioning, sharding, hot-key management, cache
invalidation, change-data capture, event streams, queues, background workers,
and batch backfill orchestration are not observed in the active implementation.
The absence matters: these are not hidden guarantees of the local JSON design.

**Concrete reliability scenario:** If a model call completes and the process
crashes before `run.json` is saved, atomic file replacement protects files that
were already replaced, but it cannot roll back the remote model call. On retry,
the deterministic run ID helps resume the same logical cycle, while the model
call may happen again. This is recovery by durable checkpoints, not a distributed
transaction.

---

## 9. Computational reasoning

The code mostly uses practical traversal, lookup, aggregation, and state-machine
patterns rather than a difficult textbook algorithm. Complexity below excludes
opaque database/network behavior and calls out filesystem/provider I/O separately.

### Example 1: fixed date-window traversal

**Problem:** Ensure every source has complete coverage for the fourteen dates
ending at a completed `through` date.

- **Code:** `datesBetween()` and the nested checks in
  [`marketplace-evidence-preparation.ts`](src/workflow/marketplace-evidence-preparation.ts#L101).
- **Pattern:** fixed-range traversal plus hash lookup in a `Map` keyed by
  `source/date`.
- **Pseudocode:**

  ```text
  snapshots = map existing snapshots by source/date
  for each date in the 14-day window:
      for each source in {posthog, fly_metrics, shopify_partner}:
          reuse if complete
          otherwise collect that date's source data
  reject if any source/date is still incomplete
  ```

- **Invariant:** the final incomplete-reference list is empty before weekly
  aggregation begins.
- **Complexity:** with `D` dates and `S` sources, in-memory checks are `O(D*S)`
  time and `O(D*S)` space for the snapshot map. Here `D = 14` and `S = 3`, but
  the source collection calls and filesystem reads dominate end-to-end latency.
- **Edge cases:** current/future UTC date, partial snapshot, missing snapshot,
  failed collection, and a provider that returns no complete record.
- **Simpler alternative:** query each source/date directly without first loading
  a map. That can be easier to write but repeats reads and makes reuse accounting
  less explicit.
- **Recognition clue:** when a problem says “cover every combination of dates
  and sources,” look for a bounded Cartesian-product traversal and a composite
  key.

### Example 2: seven-day aggregation and derived rates

**Problem:** Turn daily source snapshots into one weekly period while preserving
coverage and freshness information.

- **Code:** [`buildWeeklyPeriod`](src/metrics/summaries.ts#L100) and
  [`buildWeeklyBusinessReview`](src/metrics/summaries.ts#L77).
- **Pattern:** group by date/source, count coverage, sum additive metrics, then
  derive rates from validated numerator/denominator pairs.
- **Tiny example:** seven daily snapshots contain `scan_started_count = 10` and
  `scan_completed_count = 5` in total. The weekly artifact records
  `scan_completion_rate = 0.5`. If starts are zero or missing, the rate is absent
  and the limitation remains visible.
- **Invariant:** a weekly period has exactly seven consecutive dates, and two
  compared periods are adjacent. This is enforced before change calculation.
- **Complexity:** if `D = 7`, `S` is the number of sources, and `M` is the number
  of metric fields, aggregation is approximately `O(D*S*M)` arithmetic after
  snapshots are loaded. The implementation also filters snapshots by date, so
  the exact cost includes those in-memory scans. Provider latency is separate.
- **Edge cases:** duplicate dates, nonconsecutive windows, incomplete statuses,
  zero denominators, derived-rate fields that must not be summed, and
  `active_merchants` being a point-in-time value rather than an additive count.
- **Simpler alternative:** sum every numeric field. That is shorter but wrong for
  rates and point-in-time metrics.
- **Recognition clue:** classify fields as additive, point-in-time, or derived
  before choosing an aggregation operation.

### Example 3: exact product-history lookup

**Problem:** Find the newest run belonging to exactly one marketplace profile and
  product reference.

- **Code:** [`findLatestByProduct`](src/storage/runs.ts#L86).
- **Pattern:** directory scan, parse/filter, then sort by recency with a
  deterministic run-ID tie-breaker.
- **Pseudocode:**

  ```text
  entries = list run directories
  matches = []
  for each directory:
      state = load and validate run.json
      if profile and productRef match: append state
  sort matches by createdAt descending, then runId descending
  return first match or undefined
  ```

- **Invariant:** a run from another profile or product cannot become prior
  history; equal creation times still produce a deterministic winner.
- **Complexity:** with `R` run directories, this performs `O(R)` directory/file
  reads and parsing, then `O(R log R)` sorting in the current implementation.
  Space is `O(R)` for loaded matches. End-to-end cost is dominated by filesystem
  I/O, not the comparison itself.
- **Edge cases:** missing root, corrupt candidate, legacy run without marketplace
  identity, equal timestamps, and an exact identity with no match.
- **Alternative:** maintain an index file or database keyed by profile/product.
  That reduces lookup work at scale but introduces index consistency and recovery
  responsibilities.
- **Recognition clue:** a directory scan followed by filtering and “newest”
  selection is a full-scan query; ask when it will outgrow local storage.

### Transferable problem-solving heuristic

Before judging an implementation, name the invariant that must hold after each
boundary. Here the useful invariants are “every source/date is complete,” “weekly
periods are adjacent,” and “run identity matches evidence identity.” Once the
invariant is explicit, the right data structure, validation point, test, and
failure behavior become much easier to evaluate.

---

## 10. Stage 2 checkpoint

The domain rules, runtime components, code organization, data lifecycle, and
algorithms now connect as one model:

```text
provider or owner input
  -> connector contract
  -> local snapshot / evidence transformation
  -> deterministic workflow state transition
  -> bounded module output
  -> persisted source state and readable projections
  -> owner decision or later evidence
```

Three questions to answer before moving on:

1. If a weekly artifact is reused, which daily records remain authoritative, and
   what event or code path would cause the weekly artifact to be regenerated?
2. Which guarantees apply only within one Node process, and what would need to
   change before two concurrent CLI processes could safely share the run root?
3. For a missing `scan_completion_rate`, which boundary should you inspect first:
   provider parsing, daily snapshot completeness, weekly aggregation, or module
   validation—and what evidence would distinguish those causes?

Stage 2 ends here. Say **“continue”** to add Stage 3: failure investigation,
security/performance analysis, design trade-offs, glossary, and a practical
onboarding path.

---

## 11. Stage 3: investigate, compare, and practice

Stage 3 turns the repository map into an investigation method. The key habit is
to begin with the visible symptom, locate the boundary that produced it, and
then compare the observed guarantee with the guarantee the caller expected.

### Failure, security, and performance

#### Failure paths visible in the code

| Scenario | Origin and visible result | Recovery or evidence | Coverage |
| --- | --- | --- | --- |
| Provider times out | `FetchHttpClient` aborts after a finite deadline; the source adapter converts the failure into a `failed` snapshot with a classified note. Evidence preparation later reports the missing/non-complete `source/date`. | Check the snapshot status and note, then rerun after the provider/configuration issue is fixed. There is no automatic retry/backoff queue. | Connector tests cover normalized failures; end-to-end tests cover missing-source handling. |
| Provider returns malformed JSON | The HTTP boundary throws a malformed-response marker; classification becomes `schema`; the workflow does not treat it as complete evidence. | Inspect the source snapshot and provider response behavior through a fake test. | Provider adapter tests cover malformed and failure cases. |
| Model output violates its schema | `runStructuredModule()` parses the output with the requested Zod schema and raises a validation `AppError`. | Inspect module input, prompt, output schema, and fake-runner test; do not weaken the schema merely to make the call pass. | [`runner.test.ts`](src/tests/agents/runner.test.ts#L66) covers malformed output. |
| Workflow stage is called too early | `assertCanRunStage()` returns `route_not_allowed` when prerequisites such as M1, M2, M5, approval, or result evidence are missing. | Load `run.json`, compare `stage/status/moduleOutputs`, then follow `routes.ts` and the guard that rejected the transition. | Engine and guard tests cover illegal transitions and waits. |
| Snapshot write races | A per-file lock serializes one source/date; another writer can receive `storage_failed` if the lock is held beyond the configured deadline. | Preserve the existing winner, inspect the lock path, and retry only after confirming the competing writer is finished. | [`metric-snapshots.test.ts`](src/tests/storage/metric-snapshots.test.ts#L114) covers the lock behavior. |
| Persisted run JSON is corrupt | `JsonFileRunRepository.load()` reports a corrupt JSON/storage error before workflow code uses it. | Restore from a known-good backup or test fixture; no backup/repair service is implemented. | Run-storage tests cover corrupt and schema-invalid JSON. |
| Failure occurs after a remote call but before local state | Atomic local files remain individually consistent, but the remote call cannot be rolled back. A retry may repeat it. | Compare operation events and `run.json`; use deterministic IDs to resume the logical cycle, while accepting at-least-once external execution. | The guarantee is documented by storage design; live crash recovery is not tested against real providers. |

#### A concrete investigation walkthrough

Suppose the owner sees `storage_failed: Missing weekly metric snapshots`.

1. Start at the CLI error channel in `safeCliError()` and preserve the exact
   source/date list. It is the most useful bounded diagnostic emitted to the
   operator.
2. Open the configured snapshot root and inspect the listed files. Confirm
   whether each file is absent, has a non-`complete` status, or contains invalid
   JSON.
3. Follow the missing date into the relevant adapter: PostHog, Fly, or Shopify
   CSV. Check the configuration key, request status, response shape, and the
   adapter's failure classification.
4. Compare the source snapshot's `collectedAt`, status, metrics, and notes with
   the `DailyMetricSnapshotSchema`. A malformed or partial file is a data-quality
   issue, not evidence that the workflow engine is broken.
5. Rerun the preparation path in a temporary test directory with a fake adapter.
   If the test completes after the missing source is supplied, the failure is at
   ingestion/configuration. If it still fails, inspect window selection and
   `incompleteSnapshotRefs()`.

This separates three plausible causes: external availability, local data
quality, and date-window logic. It also avoids exposing credentials or raw
provider payloads while investigating.

#### Security boundaries and limits

Observed protections include:

- required configuration is read at connector boundaries rather than passed as
  workflow evidence;
- `sanitizeModuleInput()` removes nested keys that look like `secret`, `token`,
  or `api_key` before model execution;
- `assertNoCredentialKeys()` rejects credential-like keys in workflow state and
  event data;
- operation events intentionally record lifecycle facts, counts, statuses, and
  artifact references rather than raw provider payloads or full prompts;
- local context paths are rejected when they contain a URL scheme;
- hosted web-search queries reject credential-like assignments and require
  HTTPS citation URLs.

These controls are not equivalent to a complete security system. The key filter
is heuristic, local filesystem permissions are trusted, there is no user
authentication or authorization layer, and secrets could still appear in values
under an innocuous key. Privacy requirements, encryption at rest, key rotation,
and multi-account isolation are **Unknown**.

#### Performance and the first likely bottleneck

No production workload or latency target is specified. Under a hypothetical
workload with many historical runs or many products, the first likely pressure
points are:

1. **External collection and model latency:** the synchronous review command
   waits for source adapters, weekly aggregation, and module calls.
2. **Run-history lookup:** `findLatestByProduct()` lists and parses every run
   directory before sorting matches. Its work grows with total run count, not
   only the requested product's history.
3. **Local filesystem projections:** each state save rewrites `run.json` and
   readable projections, which is simple but not optimized for concurrent or
   high-volume writes.

These are hypotheses, not measured bottlenecks. Before redesigning, measure
provider latency, number of snapshots and runs, time spent in history scans,
file-write duration, model usage, and failure rates. A database/index, worker
queue, or cached history lookup would be a system-design response only after
the workload and availability requirement are known.

### Design trade-offs

#### 1. Local files instead of a database

**Design decision:** Use JSON/JSONL repositories on one controlled machine.

**Evidence in code:** `JsonFileRunRepository`,
`JsonFileMetricSnapshotRepository`, atomic replacement, and the absence of a
database client.

**Requirement it addresses:** Inspectable local state for a sequential owner
workflow with low operational overhead.

**Trade-off:** Files are transparent, easy to fixture, and easy to back up
manually; they lack indexed queries, multi-record transactions, replication,
central access control, and convenient multi-user concurrency.

**When it stops working well:** Many products, many operators, remote access,
large run history, or a requirement for high availability.

**Alternative worth considering:** A relational store with unique keys for
`source/date`, operation IDs, and run identity, plus explicit transaction and
migration handling.

**Review question:** Which new requirement would justify introducing a database,
and what consistency boundary would the transaction need to cover?

#### 2. Deterministic engine around bounded agent modules

**Design decision:** Let TypeScript own routes and guards while modules produce
structured interpretations inside those routes.

**Evidence in code:** `createWorkflowEngine()`, `assertCanRunStage()`, Zod
module schemas, and `runStructuredModule()`.

**Requirement it addresses:** Reproducible lifecycle control and inspectable
human approval while still allowing model-assisted diagnosis, hypothesis, and
research.

**Trade-off:** Stronger control and testability cost more contracts, routing
code, and adapter seams. A free-form agent loop would be shorter initially but
would make legal transitions, retries, and safety boundaries harder to prove.

**When it stops working well:** If the number of workflow kinds and conditional
routes grows beyond what the current state model and tests can maintain.

**Alternative worth considering:** A workflow engine or durable state-machine
platform, but only if the local process model becomes an operational constraint.

**Review question:** Which decisions are deterministic policy, and which are
allowed to remain model judgment at each stage?

#### 3. Synchronous complete-evidence preparation before workflow mutation

**Design decision:** Prepare or reuse the full bounded evidence window before
starting or advancing the rolling review.

**Evidence in code:** `MarketplaceReviewService.review()` awaits `evidence.prepare()`
before calling `rollingReviews.nextReview()`.

**Requirement it addresses:** A review should not create a recommendation run
from an incomplete source window.

**Trade-off:** The command has a clear success/failure boundary and simpler
lineage, but the owner waits for collection and cannot delegate work to a worker.

**When it stops working well:** Long provider calls, many products, scheduled
operations, or a user experience that needs progress/status rather than a
blocking terminal command.

**Alternative worth considering:** Accept an operation ID, enqueue evidence
collection, and let a worker publish a completed/rejected status. That requires
durable job state, retries, idempotent job handling, and observability.

**Review question:** Is “complete evidence before mutation” still the right
boundary if source collection takes longer than an interactive command should
wait?

### Learning summary

| Book lens | Relevant concept | Repository evidence | What you should now understand | Next reading topic |
| --- | --- | --- | --- | --- |
| DDIA | Materialized views, idempotency, transactions, and recovery | Daily snapshots, weekly artifacts, deterministic IDs, atomic file writes | A durable local file and an idempotent key solve different problems; neither creates a command-wide transaction. | Crash consistency and exactly-once illusions |
| FODE | Generation → ingestion → storage → transformation → serving | Provider adapters, Zod contracts, snapshot/artifact stores, workflow outputs, CLI | Data engineering applies even to a small CLI when lineage, freshness, quality, and ownership matter. | Data quality, lineage, and operational data products |
| System Design Interview | Requirements-first boundaries and scaling trade-offs | Single-owner filesystem architecture, synchronous façade, no known SLOs | Component choices are responses to known constraints; scale and availability claims need workload evidence. | Capacity estimation and asynchronous job design |
| Algorithmic Thinking | Invariants, bounded traversal, grouping, and full-scan lookup | Fourteen-day/source traversal, seven-day aggregation, run-history scan | Correctness comes from naming what must hold after each transformation, then choosing data structures around that invariant. | Hash maps, aggregation, sorting, and complexity with I/O |

#### Glossary

| Term | Plain-English meaning | Where it appears | Why it matters |
| --- | --- | --- | --- |
| Contract | A validated shape allowed across a boundary | `src/contracts/`, Zod schemas | Prevents provider details or malformed model output from silently entering workflow state |
| Source of truth | The record treated as authoritative | Daily snapshots and `run.json` | Tells you which file to inspect when a projection disagrees |
| Projection | A readable copy derived from authoritative state | `events.jsonl`, `experiment-plan.json`, evidence files | Useful for humans, but should be rebuildable or explainably refreshed |
| Idempotency | Repeating the same logical request converges on the same durable result | Operation/run IDs and reuse branches | Makes sequential retries safer without promising exactly-once external work |
| Materialized view | A stored result of a transformation | Weekly review artifact | Trades recomputation for freshness and invalidation responsibility |
| Invariant | A condition that must remain true | Identity agreement, complete windows, legal stages | Gives code review and tests a precise correctness target |
| Side route | A conditional workflow branch that returns to a requester | M3 research in `engine.ts` | Prevents optional research from becoming an uncontrolled linear loop |
| Critical section | Code that must not be interleaved unsafely | Snapshot lock and experiment-application promise lock | Explains what concurrency is controlled and what remains unprotected |
| Lineage | The links from source input to derived output | Source/date → weekly artifact → evidence → run | Supports debugging, freshness reasoning, and trust in recommendations |
| Backfill | Reprocessing historical dates after data was missing | Past completed UTC snapshots may be collected | Distinguishes historical repair from collecting current/future data |

### Practical onboarding path

The following path is read-only and designed to build confidence in layers.

#### First session: build the map

1. Read this README through the architecture diagram and write down the five
   boundary types: CLI, external provider, contract, workflow, and storage.
2. Read `src/contracts/README.md` and `src/contracts/workflow.ts`. Goal: name
   the difference between evidence, module output, and run state.
3. Read `src/cli/marketplace-visibility.ts` and draw the dependency graph from
   `createMarketplaceVisibilityDependencies()`. Demonstrate understanding by
   identifying which objects are concrete filesystem/provider implementations
   and which are injected ports.
4. Read the marketplace-review end-to-end test. Predict the final stage/status
   before looking at its assertions, then compare your prediction.

#### Next few sessions: follow state and data

1. Trace one missing snapshot through the adapter, snapshot repository, weekly
   preparation, and bounded CLI error. Goal: distinguish ingestion failure from
   workflow routing failure.
2. Trace `productRef` and `through` into the operation ID, cycle run ID, evidence
   identity, and history lookup. Goal: explain why a retry finds the same cycle.
3. Read `workflow/engine.ts`, `guards.ts`, and `routes.ts` together. Goal: state
   the precondition for M2, M4, M5, approval, result evaluation, and M7.
4. Inspect a tracked `run.json`, its events, and its experiment plan. Goal:
   classify each field as authoritative state, derived projection, or external
   reference.

#### Later study: challenge the guarantees

1. Compare the local file design with a database-backed design on transaction
   boundaries, indexes, backups, and concurrent writers.
2. Add timing measurements locally without changing product behavior. Measure
   history-scan time, snapshot-list time, provider latency when using fakes, and
   projection write time.
3. Use a temporary test directory to remove one snapshot or corrupt one run file.
   Predict the error, then verify it through the existing tests and repository
   code. Do not modify tracked artifacts.

#### Five repo-specific teach-back questions

1. What is the exact difference between `marketplaceReviewOperationId()` and
   `rollingVisibilityRunId()`, and why are both needed?
2. Which files can be rebuilt from `run.json`, and which inputs are needed to
   rebuild them safely?
3. Why does a provider timeout become a non-complete snapshot instead of an
   immediate workflow recommendation?
4. Which concurrency guarantee is provided by the snapshot lock, and why does it
   not make two CLI processes safe for the whole workflow?
5. If the weekly artifact is stale, which code path reuses it and what evidence
   would you collect before proposing invalidation changes?

#### Small read-only exercise

Using a copy of the repository or a test temporary directory, annotate the
`marketplace-review.e2e.test.ts` fixture with this sequence:

```text
input context
  -> missing posthog/date snapshot
  -> fake adapter collection
  -> weekly artifact generation
  -> rolling workflow start
  -> approval_wait
  -> second invocation reuses the same run/artifact
```

For each arrow, write the responsible function and one invariant. Finish by
explaining which assertion proves reuse and which assertion proves credentials
and raw provider fields did not enter operation events. This exercises navigation,
data flow, correctness, and failure reasoning without implementing a feature.

Stage 3 completes the repository onboarding guide. The next useful step is to
answer the teach-back questions aloud or continue with a specific flow or
failure scenario.
