# MerchGrid Workflow Integration Design

**Date:** 2026-08-23
**Status:** Proposed design, pending review
**Depends on:** `docs/superpowers/specs/2026-08-20-merchgrid-business-review-aggregation-design.md` and `docs/superpowers/specs/2026-08-12-etsy-workflow-engine-design.md`

## Goal

Connect the existing MerchGrid daily-health and weekly-review evidence artifacts
to Buffr's existing deterministic workflow engine. The result is one engine
with two product-specific entry paths:

- a **daily health investigation** for a material operational concern; and
- a **weekly business recommendation** that can produce a human-approved
  hypothesis and experiment plan.

This is not a second workflow engine and not an autonomous production-change
system. It is a product-specific adapter and module set that lets the existing
engine reason from MerchGrid's aggregate evidence.

> **DDIA lens — dataflow boundary:** The daily and weekly artifacts are derived
> data produced by the source pack. This design makes their handoff into the
> workflow explicit, rather than allowing a module to query PostHog, Fly, or
> Shopify directly. The workflow therefore consumes a stable evidence contract,
> not live provider state.

## Why This Seam Exists

Buffr already has a deterministic workflow engine: lifecycle routing, evidence
gates, waits, structured module outputs, local run persistence, tracing, and
the M1–M7 sequence. Its current public input is
`NormalizedListingEvidence`, which is intentionally Etsy/listing-specific.

MerchGrid already produces a different kind of evidence:

- daily health: source freshness, collection status, request/error aggregates,
  product-event counts, and limitations for one closed UTC day;
- weekly review: two closed seven-day periods, aggregate changes, coverage,
  freshness, and limitations.

Neither artifact is currently accepted by `createWorkflowEngine().start()`.
The missing work is the translation and policy seam between the aggregate
artifact and the engine—not collection, another AI system, or another
orchestrator.

## Scope

This design adds the following capabilities:

1. A typed, privacy-safe MerchGrid workflow evidence contract derived from
   existing review artifacts.
2. A product-aware workflow entry adapter that creates a run using that
   contract, without changing the provider adapters or metric snapshots.
3. Two deterministic readiness policies: one for daily investigation and one
   for weekly recommendations.
4. MerchGrid-oriented M1/M2/M4/M5/M6 module wiring that produces the existing
   structured outputs expected by the workflow engine.
5. A human-in-the-loop approval checkpoint before an experiment is treated as
   ready for manual execution.
6. A post-experiment evidence path that reuses later weekly reviews for the
   existing M2-results and M7-learning stages.

## Non-goals

- Building another workflow engine, dashboard, scheduler, warehouse, or
  real-time alerting system.
- Re-querying PostHog, Fly, or Shopify from workflow modules.
- Changing MerchGrid, Shopify, listings, deployments, or settings
  automatically.
- Allowing an LLM to choose evidence queries, override readiness gates, or
  advance a run without deterministic routing.
- Generalizing the whole engine for Etsy, Meta, and every future platform in
  this first integration. The seams must be reusable, but the first working
  vertical slice is MerchGrid.
- Treating an empty or partial source as a measured zero or healthy result.

## Architecture

### One shared engine, two MerchGrid entry paths

```text
                    MERCHGRID SOURCE PACK (already built)

 PostHog ───┐
 Fly ───────┼──> daily snapshots ──> daily health artifact
 Shopify ───┘             │                    │
                           └──> weekly review artifact
                                        │
                                        v
                         +---------------------------+
                         | MerchGrid workflow seam    |
                         | - artifact validator       |
                         | - evidence adapter         |
                         | - readiness policy         |
                         +-------------+-------------+
                                       │
                   +-------------------+-------------------+
                   │                                       │
                   v                                       v
       daily investigation run                  weekly recommendation run
       concern / wait / collect                 diagnosis / hypothesis /
       more data / manual triage                test plan / human approval
                   │                                       │
                   +-------------------+-------------------+
                                       v
              existing deterministic Buffr workflow engine
              routes, guards, persistence, M1–M7, M3 limits,
              tracing, experiment wait, M2 results, M7 learning
```

The source pack owns extraction, normalization, snapshot storage, and summary
construction. The workflow seam owns only artifact validation, interpretation
readiness, and product-specific translation. The engine remains responsible for
all lifecycle transitions, wait states, run persistence, and approval state.

> **DDIA lens — separation of concerns:** The source pack is a small batch
> pipeline; the workflow engine is a decision-process coordinator. Keeping
> these responsibilities separate means a provider outage cannot be mistaken
> for an agent conclusion, and an agent cannot silently alter historical facts.

> **Fundamentals of Data Engineering lens — data integration lifecycle:** This
> boundary separates ingestion from consumption. The source pack acquires and
> validates data; the workflow uses curated evidence. Coverage, freshness, and
> limitations travel with the artifact as data-quality metadata, so the
> downstream recommendation process can judge whether an input is fit for use.

### Shared core and product-specific modules

The existing engine has reusable mechanics but listing-specific input types and
metrics. This integration introduces a narrow product-evidence boundary rather
than forcing MerchGrid aggregates into a fake Etsy listing.

```text
                         Shared workflow core
+------------------------------------------------------------------+
| Run state | routes | guards | events | research limits | storage |
| M3 return behavior | experiment wait | result/learning lifecycle |
+------------------------------+-----------------------------------+
                               ^
                               |
                  Product workflow profile / adapter
                               |
       +-----------------------+-----------------------+
       |                                               |
       v                                               v
 Etsy listing profile                            MerchGrid profile
 listing evidence                                daily/weekly evidence
 listing metric module                           aggregate metric qualifier
 listing experiments                             product/operational experiments
```

The first implementation may keep the existing Etsy public APIs intact while
adding parallel MerchGrid-specific entry functions and module executor wiring.
It must not broaden types by making important fields optional everywhere. The
shared core is extracted only where the MerchGrid profile demonstrates an actual
shared need.

> **APOSD lens — deep modules and information hiding:** A MerchGrid profile
> should expose a small interface—“start a daily investigation” or “start a
> weekly review”—while hiding artifact paths, source-specific metric names, and
> readiness arithmetic. The engine does not need to know whether an input came
> from Shopify, Etsy, or a future source pack.

## Evidence Contracts

### Artifact input

The adapter reads only a persisted `MerchGridReviewEvidence` artifact produced
by the source-pack repository. It does not accept provider payloads, token
values, raw PostHog events, raw Fly responses, Shopify rows, shop domains, or
catalog data.

Conceptually, the workflow-facing contract is:

```ts
type MerchGridWorkflowEvidence = {
  product: 'merchgrid';
  kind: 'daily_health' | 'weekly_review';
  artifactRef: string;
  observedPeriod:
    | { kind: 'daily'; date: string }
    | { kind: 'weekly'; previous: DateRange; current: DateRange };
  sourceCoverage: SourceCoverage;
  sourceFreshness: SourceFreshness;
  aggregateMetrics: SourceMetricValues;
  limitations: string[];
};
```

`artifactRef` identifies the local derived artifact for a run but is not a
credential or provider URL. `aggregateMetrics` is copied only after strict
schema validation and allowlisting. The workflow run persists this normalized
evidence as its initial evidence snapshot, alongside an evidence version and
the readiness decision that admitted it.

> **DDIA lens — schema evolution and provenance:** A workflow run records the
> exact period, sources, freshness, and limitations that informed its output.
> That provenance lets a later review distinguish “the hypothesis was poor”
> from “the source data was partial,” without re-querying mutable dashboards.

### Daily readiness policy

Daily health is an operational triage input, not automatic proof that a
business change is needed. A daily artifact may start an investigation only
when all of the following are true:

1. the artifact covers one completed UTC day;
2. its source statuses and freshness are valid enough to evaluate the stated
   concern; and
3. a deterministic concern rule is met.

Initial concern rules are deliberately narrow:

| Signal | Daily workflow outcome |
| --- | --- |
| A required source is unavailable, failed, or stale | Wait or request data; do not diagnose product behavior. |
| `request_count` is present and `error_rate` crosses a configured material threshold | Start an operational investigation. |
| Requests are present, error rate is below threshold, and no source is materially incomplete | No workflow run; persist the health artifact only. |
| Product events materially change but reliability coverage is incomplete | Wait or request more data. |

The initial design records the threshold as a named configuration decision; it
does not bury a magic number in an agent prompt. The first implementation plan
will choose the exact conservative threshold and require a test for it.

Daily investigations may return only these outcomes: `healthy_no_action`,
`investigate`, `collect_more_data`, or `manual_triage`. They do not create a
product experiment or modify MerchGrid automatically.

> **DDIA lens — missing-data semantics:** “No metric,” “zero requests,” and
> “a measured high error rate” are three different facts. The daily gate keeps
> them distinct so the engine cannot optimize around an outage or infer uptime
> from incomplete monitoring.

### Weekly readiness policy

Weekly evidence is the primary input for a product recommendation. A weekly
review may advance into diagnosis only when:

1. both periods are exactly seven completed UTC days;
2. required source coverage is complete enough for each metric considered;
3. source freshness and limitations are attached to the run; and
4. deterministic metric qualification produces at least one interpretable
   product or business signal.

If coverage is incomplete, contradictory, or insufficient, the engine creates
a bounded wait/request-for-data outcome rather than a diagnosis. A partial
weekly review may still be saved and displayed as evidence, but it cannot be
silently promoted to a recommendation.

The weekly M2 metric qualifier converts aggregate values into the existing
`MetricsOutput` shape. It names the metric, current and baseline values,
absolute and percentage changes, qualification, confidence, and unresolved
data needs. The downstream M4–M6 stages therefore retain their existing
contract: they receive qualified metrics and provenance, not raw sources.

> **DDIA lens — derived data and deterministic recomputation:** Weekly rates
> are derived from stored numerators and denominators, while change is derived
> from two frozen weekly windows. The deterministic qualifier makes those
> computations before any model interprets them, so an LLM cannot invent or
> rewrite the business measurement.

> **Fundamentals of Data Engineering lens — batch orchestration and data
> quality:** The weekly review is a batch-derived analytical product, built only
> after its upstream daily observations close. The readiness gate is a quality
> check at the consumer boundary: incomplete coverage is preserved as a
> limitation instead of being transformed into a confident-looking metric.

## Workflow Behavior

### Daily investigation path

```text
daily health artifact
        |
        v
validate + daily readiness gate
        |
        +-- no material concern --> persist artifact only; healthy_no_action
        |
        +-- missing/stale evidence --> waiting_for_data; collect_more_data
        |
        +-- material concern ------> M1 operational context
                                         |
                                         v
                                   M2 daily qualification
                                         |
                                         v
                                   M4 investigation diagnosis
                                         |
                                         +--> manual_triage / collect_more_data
```

The daily path terminates before M5/M6 unless a later approved design explicitly
adds an escalation rule. Its purpose is to preserve operational context and
identify whether reliable data exists for a human to investigate.

### Weekly recommendation path

```text
weekly review artifact
        |
        v
validate + weekly readiness gate
        |
        +-- insufficient coverage --> waiting_for_data
        |
        +-- qualified metrics ----> M1 product context
                                         |
                                         v
                                   M2 weekly qualification
                                         |
                                         v
                               M4 diagnosis (bounded interpretation)
                                         |
                                         v
                               M5 hypothesis
                                         |
                                         v
                               M6 proposed test plan
                                         |
                                         v
                           human-in-the-loop approval checkpoint
                                         |
                           +-------------+-------------+
                           |                           |
                        reject / wait              approve
                                                       |
                                                       v
                                             experiment_wait
                                                       |
                                                       v
                                later weekly review as result evidence
                                                       |
                                                       v
                                             M2 results -> M7 learning
```

The approval checkpoint is a human-in-the-loop governance boundary. Approval
records an intent to manually perform a change or test; it never gives Buffr
write access to MerchGrid, Shopify, Fly, PostHog, or production infrastructure.

> **AI Agents in Action lens — human control at an action boundary:** The agent
> can help form a hypothesis and a test plan, but its output is a proposal, not
> an action. Human approval separates reasoning from effectful change and gives
> the owner a clear point to reject, revise, or defer the recommendation.

> **Release It! lens — fail-safe operations:** Reliability evidence can block a
> recommendation when it is incomplete or materially unhealthy. This favors a
> controlled wait over a plausible but unsafe product change made during an
> operational incident.

## Module Responsibilities

| Stage | Daily investigation profile | Weekly recommendation profile |
| --- | --- | --- |
| M1 context | Describes the operational period, available sources, and known limitations. | Describes the product period, source coverage, and business context. |
| M2 metrics | Deterministically qualifies health and reliability metrics. | Deterministically qualifies week-over-week product and business metrics. |
| M3 research | Optional bounded research only when a specific question is needed. | Same bounded sidecar; may research market/domain context but cannot query providers outside configured tools. |
| M4 diagnosis | Explains possible operational concern and competing explanations. | Identifies likely product/business bottleneck and competing explanations. |
| M5 hypothesis | Not used in initial daily path. | States a falsifiable hypothesis and one proposed manual change. |
| M6 test plan | Not used in initial daily path. | Freezes a primary metric, baseline period, success/weakening signals, and inconclusive condition. |
| M2 results / M7 learning | Not used in initial daily path. | Compares later evidence with the frozen test plan and records the learning. |

M1, M4, M5, M6, and M7 may be LLM-backed structured modules. M2 remains
deterministic for metric qualification. Every output remains validated against
the existing module schemas or a narrowly extended product-neutral equivalent.

> **AI Agents in Action lens — deterministic orchestration with bounded
> specialists:** The workflow engine is the orchestrator, while M1–M7 are
> focused workers with typed inputs and outputs. M2 retains deterministic
> measurement work; agent-backed modules interpret that prepared evidence. This
> division prevents a general-purpose agent from becoming both data pipeline,
> decision-maker, and lifecycle controller.

## Persistence, Tracing, and Idempotence

- A workflow run stores the normalized MerchGrid evidence, artifact reference,
  readiness outcome, source coverage, freshness, limitations, module outputs,
  and events.
- The source snapshots and review artifacts remain the original derived-data
  records. A run links to them; it does not mutate them.
- Starting the same artifact more than once requires an explicit run identity.
  A future deduplication policy may prevent duplicate investigations, but this
  first design records every requested run rather than silently merging them.
- Workflow and source-pack events use bounded structured data. They never carry
  credentials, raw provider responses, shop domains, catalog data, or raw
  events.
- A post-experiment run links to the later weekly artifact and preserves the
  frozen M6 baseline. It never recomputes the original baseline from live data.

> **DDIA lens — idempotence and immutable history:** The same completed
> source/date snapshot is stable evidence, and a weekly review references fixed
> windows. This lets a later learning stage compare like with like instead of
> treating a mutable dashboard as historical truth.

## Failure Handling and Safety

| Condition | Deterministic behavior |
| --- | --- |
| Artifact missing, corrupt, or fails schema validation | Reject the start request; create no workflow run. |
| Artifact has partial, unavailable, failed, or stale required source coverage | Persist/retain the artifact, then route to waiting for data or manual triage. |
| Daily reliability concern lacks measured request/error denominator | Do not infer an error rate, availability, or incident. |
| Agent output fails its Zod schema | Reject the output and keep the run at its current safe boundary. |
| M3 reaches a tool/time/token/cost limit | Stop research and return a bounded unresolved result to the requesting stage. |
| Human rejects a proposed test | Persist the decision and end or wait the run; no production action occurs. |
| Later result evidence does not meet the frozen measurement rules | Route to waiting for data or an inconclusive learning outcome. |

## Testing Strategy

Implementation should use fakes and fixed clocks only. It must include:

1. Contract tests rejecting credentials, provider payloads, raw event content,
   and malformed period/source coverage.
2. Daily-gate tests for no concern, high measured error rate, missing/stale
   evidence, and zero-request semantics.
3. Weekly-gate tests for complete comparable windows, incomplete coverage,
   missing metric denominators, and qualified week-over-week metrics.
4. Engine integration tests proving the daily path cannot reach M5/M6 and the
   weekly path reaches M6 only after a valid readiness decision.
5. Approval tests proving approve/reject routes do not invoke a provider write.
6. Post-experiment tests proving a later weekly artifact is compared with the
   frozen M6 baseline and feeds M2 results then M7 learning.
7. End-to-end faked tests that persist a run, trace events, initial evidence,
   and a result artifact without exposing a credential.

## Decisions and Deferred Work

- **Use two paths, one engine.** Daily health handles operational concern;
  weekly review handles product recommendations. This avoids conflating an
  outage with a growth experiment.
- **Start with conservative daily escalation.** Daily workflow output is
  investigation, wait, or triage—not an autonomous recommendation or test.
- **Keep the adapter product-specific first.** Reuse only core behavior proven
  common to Etsy and MerchGrid. A future Etsy/Meta source pack extends this
  pattern rather than forcing premature universal types.
- **Keep source collection independent.** The workflow reads artifacts; it
  does not become a scheduler or provider-query client.
- **Defer exact thresholds and metric prioritization.** Those are explicit
  product-policy decisions for the implementation plan and must be tested, not
  inferred by a model.
- **Defer a dashboard and notification channel.** The first user interface can
  remain explicit local commands and persisted artifacts.

## Done Means

This design is realized when Buffr can:

1. load a valid daily or weekly MerchGrid artifact through a typed adapter;
2. start the appropriate existing-engine run with evidence provenance;
3. deterministically wait when required evidence is incomplete;
4. produce a weekly M6 proposed test only after coverage and qualification
   gates pass;
5. require explicit human approval before `experiment_wait`;
6. accept a later weekly artifact as result evidence and finish through M7; and
7. keep all provider credentials and raw source data outside workflow state,
   traces, and persisted artifacts.
