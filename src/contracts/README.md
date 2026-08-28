# Buffr contracts guide

This folder is Buffr's product language.

Buffr is an evidence-to-decision system: it takes small, trusted inputs, turns them into normalized evidence, runs that evidence through the work engine, and produces an experiment plan or learning record. The contracts in this folder define the shapes that are allowed to cross those boundaries.

If you are new to the codebase, read these files as a map of the product before reading the implementation. The contracts answer:

- What kinds of evidence can Buffr reason about?
- What outputs can each work-engine module produce?
- What gets saved when a workflow runs?
- What is safe enough to pass from raw systems into the recommendation loop?

## The big picture

```text
Raw or human-curated sources
  ├─ Etsy listing data
  ├─ MerchGrid PostHog events
  ├─ MerchGrid Fly reliability metrics
  ├─ Shopify Partner CSV exports
  ├─ marketplace/product context JSON
  └─ public listing observations

        ↓ validate and normalize

Evidence contracts
  ├─ NormalizedListingEvidence
  ├─ DailyMetricSnapshot
  ├─ MerchGridWorkflowEvidence
  └─ MarketplaceVisibilityEvidence

        ↓ run through the work engine

Workflow contracts
  ├─ WorkflowRunState
  ├─ WorkflowEvent
  ├─ M1 context output
  ├─ M2 metrics output
  ├─ M4 diagnosis output
  ├─ M5 hypothesis output
  ├─ M6 test plan output
  └─ M7 learning output

        ↓ persisted as artifacts

Readable outputs
  ├─ run.json
  ├─ experiment-plan.json
  ├─ daily health review JSON
  ├─ weekly business review JSON
  └─ marketplace visibility review JSON
```

DDIA lens: this is a small data pipeline. The source adapters extract data, these contracts define the normalized model, and the work engine consumes the normalized evidence instead of raw provider payloads. That keeps Buffr from coupling its reasoning directly to Etsy, PostHog, Fly, Shopify, or any future platform.

APOSD lens: contracts are the information-hiding boundary. The rest of the app should not need to know the messy details of a provider export or API response. It should only know the stable shape Buffr has chosen to trust.

## How to read the files

| File | What it teaches you | Human way to read it |
| --- | --- | --- |
| `evidence.ts` | Etsy/listing evidence shape | "What facts about a listing can Buffr use?" |
| `metrics.ts` | Daily source snapshots | "What is one source allowed to report for one completed UTC day?" |
| `merchgrid-workflow.ts` | MerchGrid review evidence | "How do daily and weekly MerchGrid summaries enter the work engine?" |
| `marketplace-visibility.ts` | Sparse-data visibility evidence | "How can Buffr recommend a visibility test when metrics are weak or missing?" |
| `modules.ts` | M1-M7 module outputs | "What does each reasoning step hand to the next step?" |
| `workflow.ts` | Workflow state and lifecycle | "What happened during a run, and where did it stop?" |
| `experiments.ts` | Final experiment plan | "What concrete test is ready for a human to approve?" |

There is one important neighbor outside this folder:

| File | What it teaches you | Human way to read it |
| --- | --- | --- |
| `../metrics/evidence.ts` | Metric review evidence schemas | "How are daily snapshots summarized into daily health or weekly business evidence?" |

## Core input contracts

### `NormalizedListingEvidence`

Defined in `evidence.ts`.

This is the original Etsy/listing input shape. It captures product facts like title, description, tags, price, status, URL, and simple marketplace stats such as impressions, views, visits, favorites, orders, revenue, and ad metrics.

Read it as: "Here is the listing evidence Buffr is allowed to reason about."

The important design choice is that this is normalized. The work engine does not receive a raw Etsy payload. It receives Buffr's cleaned-up version of the listing.

DDIA concept: normalized data model. Buffr chooses one stable internal representation so future code does not have to understand every source system's native shape.

### `DailyMetricSnapshot`

Defined in `metrics.ts`.

This is one source's metrics for one completed UTC day. Current MerchGrid sources are:

- `posthog`
- `fly_metrics`
- `shopify_partner`

Each snapshot has:

- `source` — where the metrics came from.
- `date` — the completed UTC date.
- `collectedAt` — when Buffr collected it.
- `status` — whether collection was complete, partial, unavailable, or failed.
- `metrics` — numeric aggregate values only.
- `notes` — operational notes like `rate_limit`, `manual_import`, or `no_metrics`.

Read it as: "This is the smallest durable metric fact Buffr stores."

Example:

```json
{
  "source": "posthog",
  "date": "2026-08-24",
  "collectedAt": "2026-08-25T07:12:00.000Z",
  "status": "complete",
  "metrics": {
    "app_opened_count": 2,
    "scan_started_count": 1,
    "scan_completed_count": 1,
    "scan_failed_count": 0,
    "scan_completion_rate": 1
  },
  "notes": []
}
```

DDIA concept: materialized snapshot. Buffr stores a small derived record for a day so later weekly reviews do not need to re-query every raw source every time.

## MerchGrid evidence contracts

### `MerchGridReviewEvidence`

Defined in `merchgrid-workflow.ts`, with summary shapes in `../metrics/evidence.ts`.

This is how MerchGrid's operational and business data enters the work engine. It has two modes:

- `daily_health` — one day of source statuses and aggregate metrics.
- `weekly_review` — current week versus previous week.

Read it as: "This is the safe packet of MerchGrid evidence that the work engine is allowed to inspect."

It includes source coverage and freshness, not just metric values. That matters because the engine needs to know whether a recommendation is based on real signal, missing data, or partial data.

DDIA concept: provenance and data quality. Buffr does not only store the value; it also stores where the value came from, when it was collected, and whether it was complete.

### `SourceMetricValues`

Defined in `../metrics/evidence.ts`.

This is the approved metric vocabulary for MerchGrid summaries.

PostHog can report:

- `app_opened_count`
- `scan_started_count`
- `scan_completed_count`
- `scan_failed_count`
- `scan_completion_rate`

Fly metrics can report:

- `request_count`
- `error_response_count`
- `error_rate`

Shopify Partner data can report:

- `active_merchants`
- `installs`
- `uninstalls`
- `earnings_amount`

Read it as: "These are the only aggregate metric names the work engine should see for MerchGrid."

APOSD lens: this keeps the module deep. Provider-specific details stay behind the adapter boundary, while the review engine gets a compact interface.

## Marketplace visibility contracts

### `MarketplaceVisibilityContext`

Defined in `marketplace-visibility.ts`.

This is human-curated product context: marketplace, product name, target customer, customer problem, current promise, discovery surface, desired action, constraints, assets, and owner goal.

Read it as: "What do we know about the product even when there are no strong metrics yet?"

This exists because early-stage products often have sparse or zero quantitative data. Buffr should still be able to recommend a safe exploratory test, but it must be honest about low confidence.

### `MarketplaceListingContext`

Defined in `marketplace-visibility.ts`.

This is public listing observation context. It can come from a manual visual review or browser-assisted capture of a public marketplace page.

It describes things like:

- public title, subtitle, headline, and description;
- gallery/image observations;
- trust signals and friction;
- clarity of the promise and audience;
- limitations of the capture.

Read it as: "What does the public listing communicate to a potential buyer or merchant?"

Important boundary: this contract only allows public marketplace information. It rejects private admin or Partner Dashboard URLs and filters sensitive-looking text.

### `MarketplaceVisibilityEvidence`

Defined in `marketplace-visibility.ts`.

This wraps product context, optional public listing context, sparse measured signals, limitations, and prohibited claims into one evidence object for the marketplace visibility workflow.

Read it as: "Given weak metrics, here is enough qualitative evidence to propose a careful visibility experiment."

DDIA concept: different sources, one normalized evidence shape. The same pattern can later support Shopify App Store, Etsy, or Meta Marketplace without making the work engine platform-specific.

## Work engine contracts

### `WorkflowRunState`

Defined in `workflow.ts`.

This is the durable execution record. When you open `run.json`, you are usually looking at this shape.

It records:

- which workflow ran;
- what stage it reached;
- current status;
- evidence references;
- evidence snapshots;
- module outputs;
- events that happened during the run;
- approval state, if needed.

Read it as: "The black box recorder for one Buffr run."

It is not an OpenAI trace. A trace explains low-level model/tool execution. `run.json` explains Buffr's product-level workflow state in a durable format that the app can reload later.

DDIA concept: durable state. The run can be inspected after the command exits, and future UI can use the same state to show progress or history.

### `WorkflowEvent`

Defined in `workflow.ts`.

This is a human-readable event inside a run. It records an event type, stage, message, timestamp, and optional structured data.

Read it as: "What happened in sequence while the work engine ran?"

Future UI can stream or replay this kind of event to show progress. Right now the artifacts are written after the command finishes.

## M1-M7 module output contracts

Defined in `modules.ts`.

These are the reasoning steps inside the work engine.

| Module output | What it means |
| --- | --- |
| `ContextOutput` | M1 identifies product context, available evidence, missing information, and notes. |
| `MetricsOutput` | M2 compares metrics and states whether the comparison is valid, limited, invalid, or missing. |
| `ResearchOutput` | M3 or another module asks for external or source-backed research when it needs more evidence. |
| `DiagnosisOutput` | M4 identifies the likely bottleneck and decides whether to proceed, research, or collect more data. |
| `HypothesisOutput` | M5 states what change might improve the outcome and what signal should move. |
| `TestPlanOutput` | M6 turns the hypothesis into a measurable experiment plan. |
| `EvaluationOutput` | M7 evaluates the experiment result and records the learning. |

Read these as: "Each module gets one job and passes a typed result to the next module."

APOSD lens: this avoids a shallow "do everything" module. Each module has a small, named responsibility and a contract that makes its output inspectable.

## Final output contract

### `ExperimentPlan`

Defined in `experiments.ts`.

This is the human-gated action plan. It contains the hypothesis, recommended revision, test plan, status, and timestamps.

Read it as: "This is the recommendation Buffr thinks is ready for you to approve and try."

The human still decides whether to apply it. Buffr recommends; it does not automatically change production.

## How to inspect an output artifact

When you open a generated artifact, ask three questions:

1. What contract does this file match?
2. What source or workflow produced it?
3. What decision is this file meant to support?

For example:

- `snapshots/posthog/2026-08-24.json` is a `DailyMetricSnapshot`.
- `artifacts/daily-health/...json` is daily `MerchGridReviewEvidence`.
- `workflow-runs/.../run.json` is a `WorkflowRunState`.
- `workflow-runs/.../experiment-plan.json` is an `ExperimentPlan`.

That mental model keeps the product understandable: raw inputs become normalized evidence, evidence becomes a workflow run, and the workflow run produces a recommendation or a learning.
