# Marketplace Review Single Command Design

**Date:** 2026-09-10
**Status:** Proposed design, pending review
**Depends on:** `docs/superpowers/specs/2026-08-20-merchgrid-business-review-aggregation-design.md`, `docs/superpowers/specs/2026-09-08-marketplace-rolling-review-design.md`

## Problem

Buffr has already collapsed the old public MerchGrid workflow lifecycle
commands, but the owner-facing surface still exposes multiple operational
concepts:

```text
marketplace:next-review
merchgrid:collect
merchgrid:weekly-review
```

That split is still too much product machinery for normal operation. The owner
wants to run one review command and let Buffr prepare the evidence it needs.
Daily metric collection and weekly review derivation remain real internal
steps, but they should stop being public commands.

The current runtime already has most of the ingredients:

- `marketplace:next-review` starts or resumes the rolling marketplace
  recommendation cycle.
- `runDailyCollection` collects a completed UTC day through the MerchGrid
  source pack and reuses already-complete source snapshots.
- `runWeeklyReview` builds the adjacent two-window weekly artifact from
  persisted snapshots.
- `collectSourcePack` emits source-level events such as
  `merchgrid.source.started`, `merchgrid.source.completed`,
  `merchgrid.source.partial`, and `merchgrid.source.failed`.

The missing boundary is an application-level evidence-preparation step that
answers:

```text
marketplace:review
  -> what daily snapshots were required?
  -> which were reused, collected, partial, or missing?
  -> was the weekly review artifact reused or generated?
  -> did evidence prep fail before a workflow run started?
  -> which rolling workflow run did the prepared evidence feed?
```

Source-level events alone are not enough because they explain individual source
adapter calls, not the owner-visible review operation.

## Goals

1. Expose exactly one public owner-facing npm script:
   `marketplace:review`.
2. Remove public npm scripts for `marketplace:next-review`,
   `merchgrid:collect`, and `merchgrid:weekly-review`.
3. Keep MerchGrid source-pack functions as internal implementation details.
4. Have `marketplace:review` collect missing completed daily snapshots, build
   or reuse the weekly review artifact, then run the rolling marketplace
   recommendation workflow.
5. Add safe application-level trace events around evidence preparation so an
   operator can understand what happened before, during, and after workflow
   start.
6. Preserve existing workflow-engine events, run persistence, evidence
   contracts, source adapters, readiness checks, and marketplace rolling review
   semantics.
7. Keep retries idempotent: rerunning the same review must not duplicate
   completed snapshots, weekly artifacts, rolling-review events, model calls, or
   workflow runs.

## Non-goals

- Deleting the source-pack coordinator, source adapters, daily collection
  logic, weekly review builder, evidence schemas, or marketplace rolling-review
  service.
- Automatically editing Shopify, Etsy, or another marketplace.
- Storing raw provider payloads, raw CSV rows, raw private context, credentials,
  cookies, dashboard pages, or full prompts in trace events.
- Creating a dashboard, scheduler, notification system, database migration, or
  multi-product review queue.
- Reworking the OpenAI Agents SDK trace integration. Buffr's durable
  application trace remains separate from provider-level model execution traces.
- Backfilling every historical missing day indefinitely. The command prepares
  the bounded window required for the requested review cycle.

## Proposed Command Surface

The future package script surface should contain one public marketplace command:

```json
{
  "scripts": {
    "marketplace:review": "node dist/cli/marketplace-visibility.js review"
  }
}
```

These public scripts should be removed, with no advanced aliases:

```text
marketplace:next-review
merchgrid:collect
merchgrid:weekly-review
```

The normal owner path is:

```bash
npm run marketplace:review
```

For deterministic test runs and intentional backfills, the same command may
accept bounded options:

```bash
npm run marketplace:review -- --through YYYY-MM-DD
npm run marketplace:review -- --profile merchgrid_shopify_app_store
```

`--through` identifies the completed UTC date at the end of the current weekly
review window. If omitted, Buffr chooses the latest completed UTC date that can
be prepared or reused for the configured product. `--profile` should remain
available as a routing option while the code supports more than one marketplace
profile, but the command itself is still the one public owner action.

The runtime should continue loading product context from
`MERCHGRID_VISIBILITY_CONTEXT_PATH` and optional listing context from
`MERCHGRID_LISTING_CONTEXT_PATH` for the MerchGrid Shopify App Store profile.
Those environment-backed defaults prevent the owner from repeatedly passing
artifact paths.

## Internal Flow

`marketplace:review` is a facade over evidence preparation and rolling workflow
orchestration:

```text
OWNER
  |
  | npm run marketplace:review
  v
+------------------------------------------------------------------+
| Marketplace review CLI                                           |
| Parse bounded options; load env-backed context defaults          |
+-------------------------------+----------------------------------+
                                |
                                v
+------------------------------------------------------------------+
| Marketplace review coordinator                                  |
| 1. Resolve profile, productRef, and target through date          |
| 2. Prepare evidence window                                      |
| 3. Build or reuse weekly marketplace visibility evidence         |
| 4. Call existing rolling-review service                         |
| 5. Print safe run/artifact summary                              |
+-----------+-------------------+-------------------+---------------+
            |                   |                   |
            v                   v                   v
   +----------------+  +----------------+  +-----------------------+
   | Source-pack    |  | Artifact store |  | Rolling review        |
   | internals      |  | daily/weekly   |  | service + engine      |
   +----------------+  +----------------+  +-----------------------+
```

The coordinator should introduce a narrow internal service, conceptually:

```ts
type MarketplaceReviewService = {
  review(input: MarketplaceReviewInput): Promise<MarketplaceReviewResult>;
};

type MarketplaceEvidencePreparation = {
  prepare(input: EvidencePreparationInput): Promise<PreparedEvidence>;
};
```

The rolling-review service should keep its existing job: close or skip the
previous experiment, select bounded prior learning, create or resume the current
run, and advance the marketplace workflow. The new evidence-preparation service
owns only the work needed to supply fresh weekly evidence.

### Evidence Preparation Data Flow

For `merchgrid_shopify_app_store`, the required weekly evidence uses two
adjacent seven-day windows: the current window ending on `through` and the
previous window immediately before it.

```text
target through date
        |
        v
required dates: through - 13 ... through
        |
        v
for each date:
  load stored snapshots for posthog, fly_metrics, shopify_partner
        |
        +-- all complete -> reuse
        |
        +-- missing/non-complete and date is completed UTC day
              -> runDailyCollection(date) for missing sources
              -> source-level trace from collectSourcePack
        |
        +-- still incomplete after collection
              -> fail before rolling workflow mutation
        |
        v
load weekly artifact for through
        |
        +-- exists and validates -> reuse
        |
        +-- missing -> runWeeklyReview(through)
        |
        v
buildRollingVisibilityEvidence(...)
        |
        v
rollingReviews.nextReview(...)
```

The service should ask the snapshot repository what exists before invoking
source adapters. Complete snapshots are reused. Missing, partial, unavailable,
or failed snapshots inside the required fourteen-day window are candidates for
collection only if the date is completed in UTC. The source-pack repository
rules continue to protect successful snapshots from silent mutation.

Weekly review preparation should prefer a valid existing weekly artifact. If it
is absent, it should run `runWeeklyReview` after all required daily snapshots
are complete. If the weekly artifact exists but fails validation, the command
should fail with a storage or validation error instead of overwriting it
implicitly.

The resulting `MarketplaceVisibilityEvidence` should be passed to the existing
rolling review path. The public command rename should not change M1-M7 module
behavior or prior-learning semantics.

## Tracing Design

Buffr should keep one durable application trace stream using existing
`WorkflowEvent` shape and credential-key guards. Evidence-preparation events
should be emitted through the same `TraceSink` concept used by source
collection and workflow orchestration.

Event data must remain high-level and safe. Allowed fields include:

- `profile`
- `productRef`
- `through`
- `windowStart`
- `windowEnd`
- `date`
- `source`
- `status`
- `artifactRef`
- `currentRunId`
- `previousRunId`
- `reused`
- `generated`
- `missingSnapshotCount`
- `collectedSnapshotCount`
- `reusedSnapshotCount`
- `failureCode`

Event data must not include:

- raw provider payloads or response bodies;
- raw CSV rows;
- raw merchant, shop, customer, buyer, email, or domain data;
- credentials, tokens, cookies, API keys, authorization headers, or private
  dashboard URLs;
- full prompts, full model inputs, or unbounded module outputs; or
- full private context files.

### Event Taxonomy

The new application-level evidence-preparation events should be:

| Event | Emitted when | Safe data |
| --- | --- | --- |
| `marketplace_review.started` | CLI has parsed validated owner input and context defaults | `profile`, `productRef`, optional `through` |
| `marketplace_review.evidence_preparation.started` | Evidence prep begins for a bounded fourteen-day window | `profile`, `productRef`, `through`, `windowStart`, `windowEnd` |
| `marketplace_review.daily_snapshot.reused` | A complete source/date snapshot already exists | `source`, `date`, `status: complete` |
| `marketplace_review.daily_snapshot.collection_required` | A source/date snapshot is missing or non-complete | `source`, `date`, prior `status` when known |
| `marketplace_review.daily_collection.completed` | One date has finished source-pack collection attempts | `date`, `reusedSnapshotCount`, `collectedSnapshotCount`, `missingSnapshotCount` |
| `marketplace_review.weekly_artifact.reused` | A valid weekly review artifact already exists | `through`, `artifactRef`, `reused: true` |
| `marketplace_review.weekly_artifact.generated` | `runWeeklyReview` created the weekly artifact | `through`, `artifactRef`, `generated: true` |
| `marketplace_review.evidence_preparation.failed` | Evidence prep cannot produce qualified weekly evidence | `through`, `missingSnapshotCount` or `failureCode` |
| `marketplace_review.evidence_preparation.completed` | Prepared marketplace visibility evidence is ready | `through`, `artifactRef`, `reused` or `generated` |
| `marketplace_review.workflow.started` | Prepared evidence is handed to rolling review orchestration | `through`, optional `previousRunId`, `currentRunId` when already known |
| `marketplace_review.workflow.completed` | Rolling review returns a current run result | `currentRunId`, `status`, `stage`, optional `previousRunId` |
| `marketplace_review.failed` | The public command fails after validation | `failureCode`, optional bounded `stage` |

The existing source-level events remain nested evidence about adapter behavior:

```text
marketplace_review.evidence_preparation.started
  merchgrid.source.started
  merchgrid.source.completed
  merchgrid.source.started
  merchgrid.source.failed
marketplace_review.daily_collection.completed
```

The existing rolling workflow events remain authoritative for engine state:

```text
rolling_review.started
rolling_review.previous_run_found
rolling_review.prior_learning_selected
rolling_review.next_run_created
rolling_review.completed
workflow.started
workflow.advanced
...
```

Application-level events should connect those layers without copying their raw
payloads. A review run should be explainable from event type, date window,
source names, statuses, artifact references, and run IDs.

## Persistence and Auditability

`run.json` remains the source of truth for workflow state. Daily metric
snapshots, daily-health artifacts, weekly-review artifacts, evidence files,
`events.jsonl`, and `experiment-plan.json` remain derived or supporting
records.

Evidence-preparation events need a durable home even when no workflow run has
started yet. The implementation should use a deterministic review-operation ID:

```text
marketplace-review:<profile>:<productRef>:<through>
```

Before a workflow run exists, events may use that operation ID as `runId`. Once
the rolling workflow returns a current run, the coordinator should either:

- keep prep events under the operation ID and reference `currentRunId` in
  workflow events; or
- persist an operation-level `events.jsonl` under a review-operations folder.

The first implementation should prefer the smaller change that fits the current
storage model, but it must preserve pre-workflow failure evidence. A failure to
collect or build weekly evidence should leave an audit trail that does not
depend on a `workflow-runs/<run-id>/run.json` existing.

Artifact references should be local paths or documented artifact refs. Events
should record whether a daily snapshot or weekly artifact was reused or
generated, but the artifact body remains in the artifact file.

## Error Handling, Retry, and Idempotency

The deterministic cycle key is:

```text
profile + productRef + through
```

Evidence-preparation idempotency is per source/date and per weekly artifact:

- Complete daily snapshots are reused.
- Missing or non-complete daily snapshots may be recollected.
- A valid weekly artifact for `through` is reused.
- A corrupt weekly artifact fails instead of being silently overwritten.
- The rolling review service keeps its existing cycle-run idempotency.

Failure rules:

| Condition | Behavior |
| --- | --- |
| Context path missing or invalid | Fail before collection; emit bounded command failure |
| `productRef` mismatch between context and input | Fail before collection or workflow mutation |
| Requested `through` is not a completed UTC date | Validation error; mutate no snapshots or runs |
| Required date is missing and not yet completed in UTC | Report exact date/window; mutate no workflow run |
| Source adapter fails for one source/date | Persist failed snapshot through source-pack rules; continue other sources; fail weekly prep if required coverage remains incomplete |
| Weekly artifact already exists and validates | Reuse it; do not rebuild |
| Weekly artifact exists but is corrupt or mismatched | Fail with storage/validation error; do not overwrite |
| Weekly review cannot be built after collection attempts | Emit evidence-preparation failure with missing count; do not start or close a workflow run |
| Previous rolling run is awaiting owner input | Use existing owner prompt boundary |
| Owner cancels prompt | Exit without new workflow mutation; preserve completed evidence prep |
| Rolling workflow fails after evidence prep | Preserve prepared evidence and prep trace; retry resumes or recreates through existing rolling-review idempotency |

The command should print safe, actionable messages: current run ID, previous run
resolution when present, current status/stage, experiment plan ref, weekly
artifact ref, and bounded missing snapshot summaries. It should not print raw
provider errors or private data.

## Testing Strategy

This change should be test-driven around the public surface and the new
evidence-preparation boundary.

Required tests:

1. **Package surface test** proves `marketplace:review` is the only public
   owner-facing review script and that `marketplace:next-review`,
   `merchgrid:collect`, and `merchgrid:weekly-review` are absent.
2. **CLI tests** prove the `review` verb routes to the review service, rejects
   old `next-review`, and prints only safe summaries.
3. **Evidence-preparation tests** cover all-complete reuse, partial collection,
   missing completed dates, future/incomplete dates, corrupt weekly artifacts,
   generated weekly artifacts, and identity mismatch.
4. **Trace tests** assert the event taxonomy, ordering, safe fields, and absence
   of credentials, raw CSV rows, provider payloads, private context, and prompt
   text.
5. **Source-pack integration tests** prove `runDailyCollection` and
   `runWeeklyReview` remain usable as internal functions after their public npm
   scripts are removed.
6. **Rolling-review integration tests** prove `marketplace:review` still closes
   applied prior experiments, handles not-applied prior experiments, carries
   bounded prior learning, creates one current run, and remains idempotent.
7. **Failure-audit tests** prove a pre-workflow evidence-prep failure emits or
   persists a bounded event trail even when no workflow run is created.
8. **Search/removal checks** prove the removed scripts and CLI usage text no
   longer appear in active package scripts, README operational guidance, or CLI
   parsing. Historical specs under `docs/superpowers/specs/` may still mention
   prior commands as design history.

Network-facing tests should use fake adapters, fake clocks, temporary
repositories, and fake owner prompts. They should not call OpenAI, PostHog, Fly,
Shopify, Etsy, or any marketplace provider.

## Migration and Documentation Notes

Implementation should update:

- `package.json` so the public owner command is only `marketplace:review`;
- the marketplace CLI usage text and tests from `next-review` to `review`;
- README operational sections so owners see one command;
- any active package-surface test introduced during the prior command-removal
  work; and
- generated examples only if they are active operating guidance.

Historical design documents should not be edited just because they mention old
commands. They are useful records of how the system evolved. Removal checks
should either exclude historical specs or distinguish historical prose from
active command documentation.

The implementation should not migrate or rewrite existing workflow runs.
Existing `marketplace:next-review` run IDs remain readable. New
`marketplace:review` invocations should continue using the same deterministic
rolling run ID scheme unless the implementation needs a separate
operation-trace ID for pre-workflow evidence prep.
