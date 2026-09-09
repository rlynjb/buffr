# Marketplace Rolling Review Design

**Date:** 2026-09-08
**Status:** Proposed design, pending review
**Depends on:** `docs/superpowers/specs/2026-08-23-marketplace-visibility-review-design.md`, `docs/superpowers/specs/2026-08-23-merchgrid-workflow-integration-design.md`, and `docs/superpowers/specs/2026-08-28-m3-marketplace-web-research-design.md`

## Goal

Replace the marketplace visibility CLI's separate `visibility-review`,
`approve`, `reject`, and `record-result` operations with one recurring
`marketplace:next-review` command. The command must safely close the previous
experiment when one exists, retain its M7 learning, and start the next review
from fresh evidence plus a validated reference to that learning.

The normal owner experience becomes one repeatable review command and one
interactive confirmation about whether the previous experiment was applied.
Buffr remains read-only with respect to Shopify and Etsy: the owner still makes
all marketplace changes manually.

## Why This Change Exists

The implemented workflow models the lifecycle accurately, but exposes its
internal state machine as several commands. An owner currently has to remember
the run ID and choose among approval, rejection, and result-recording
operations. That is useful engine vocabulary but unnecessary operating burden.

The product is naturally cyclical. A new weekly evidence packet can close the
previous experiment and also become the observation that begins the next
decision cycle:

```text
previous plan + fresh evidence -> M2 Results -> M7 learning
                                            |
                                            v
                             fresh evidence + prior learning
                                            |
                                            v
                          next diagnosis -> next experiment plan
```

This design makes that cycle the public interface while retaining explicit,
inspectable transitions inside the deterministic workflow.

## Current Behavior

The marketplace visibility package scripts currently expose four lifecycle
operations:

```text
marketplace:visibility-review
marketplace:approve
marketplace:reject
marketplace:record-result
```

The workflow engine persists one `run.json` per run. The run contains initial
and result evidence, module outputs, approval state, and chronological business
events. `experiment-plan.json`, evidence files, and `events.jsonl` are derived
projections.

The current `RunRepository` can create, load, and save a run but cannot query
runs. MerchGrid visibility evidence uses a date-based subject reference such as
`merchgrid:visibility:2026-08-22`; that identifies an evidence instance, not a
stable product across cycles. A new run therefore cannot safely discover the
previous run for the same product.

M2 Results and M7 already close an experiment when qualified result evidence is
supplied. The missing seam is deterministic orchestration around those existing
capabilities and a safe way to carry selected learning into a new run.

## Design Decisions

1. The only public marketplace lifecycle command is
   `marketplace:next-review`.
2. A stable, owner-defined `productRef` identifies one product within a
   marketplace profile across runs.
3. `profile + productRef` is the product-history identity. Neither value alone
   is sufficient.
4. Every experiment remains a separate run and folder. Buffr never appends
   multiple cycles to one indefinitely growing `run.json`.
5. The first local implementation queries validated run files through the run
   repository. It does not introduce a second persisted index.
6. The command interactively asks whether the previous experiment was applied
   and, when applied, on what date. There is no default answer.
7. If applied, qualified fresh evidence closes the previous run through M2
   Results and M7 before a new run begins.
8. If not applied, Buffr records `not_applied`, closes the previous run without
   M2 Results or M7, and starts a fresh review.
9. The new run receives fresh evidence and a bounded, validated prior-learning
   context. It does not receive the entire previous `run.json`.
10. The existing marketplace command handlers and package scripts are removed,
    not retained as advanced aliases.
11. Shared engine primitives used by other Buffr products remain internal and
    are not deleted merely because the marketplace CLI no longer exposes them.

## Scope

This design includes:

- one rolling marketplace review CLI operation;
- an injected interactive owner-confirmation boundary;
- stable product identity in curated context, workflow evidence, and run state;
- repository lookup for the latest run by `profile + productRef`;
- deterministic applied/not-applied handling;
- reuse of a qualified weekly artifact as the previous run's result and the
  next run's baseline observation;
- a bounded prior-learning contract for new-run module context;
- idempotent cycle creation and safe retry behavior;
- removal of the old marketplace lifecycle commands and their obsolete tests
  and documentation; and
- migration behavior for existing date-keyed runs.

## Non-goals

- Editing Shopify, Etsy, or another marketplace automatically.
- Inferring that an experiment was applied from metric movement.
- Automatically collecting missing daily snapshots during `next-review`.
- Replacing `merchgrid:collect`; daily source collection remains a separate data
  pipeline concern and may still be scheduled externally.
- Training or fine-tuning a model from historical runs.
- Loading an entire historical run into an agent prompt.
- Creating a dashboard, background scheduler, notification system, database, or
  multi-product recommendation queue.
- Adding Etsy result collection in this slice. The identity and contract design
  must remain Etsy-safe, but the first rolling result path is
  `merchgrid_shopify_app_store`.
- Removing shared engine lifecycle methods that are still used by MerchGrid or
  Etsy workflows outside the marketplace visibility CLI.

## Architecture

### One public command, deterministic orchestration underneath

```text
OWNER
  |
  | npm run marketplace:next-review -- --profile ... --product-ref ... --through ...
  v
+------------------------------------------------------------------+
| Marketplace rolling-review CLI                                   |
| Parse arguments; ask applied/not-applied question when required  |
+-------------------------------+----------------------------------+
                                |
                                v
+------------------------------------------------------------------+
| Rolling review coordinator                                       |
| 1. Load fresh weekly artifact and curated context                 |
| 2. Find latest run for profile + productRef                       |
| 3. Deterministically close or skip the previous experiment       |
| 4. Build bounded prior-learning context                           |
| 5. Start and advance the next run                                 |
+-----------+-------------------+-------------------+---------------+
            |                   |                   |
            v                   v                   v
   +----------------+  +----------------+  +-----------------------+
   | Run repository |  | Source-pack    |  | Existing engine and   |
   | query/save      |  | artifacts     |  | M1-M7 modules         |
   +----------------+  +----------------+  +-----------------------+
            |
            v
   workflow-runs/<run-id>/
     run.json                 authoritative run state
     experiment-plan.json     derived recommendation
     events.jsonl             derived event projection
```

The coordinator is a product-level facade over existing engine operations. It
owns cycle-to-cycle ordering and user interaction but not evidence collection,
agent interpretation, workflow transition rules, or file serialization.

> **A Philosophy of Software Design lens — deep interface:** The owner sees one
> operation even though the coordinator performs lookup, validation, lifecycle
> closure, learning projection, and new-run creation. Those details remain
> available in events and tests without leaking into the normal command surface.

> **Head First Design Patterns lens — Facade:** `next-review` is a facade over
> existing workflow services. The pattern is useful here because the underlying
> operations remain meaningful internally while the public interface becomes
> smaller.

### Same-cycle and cross-cycle data flow

```text
                SAME RUN: automatic connection

previous run                         fresh weekly artifact
M5 hypothesis  -------------------+  current evidence window
M6 test plan    ----------------+  |             |
appliedAt       -------------+  |  |             |
                               v  v  v             v
                           validate result evidence
                                      |
                                      v
                              M2 Results -> M7
                                      |
                                      v
                           completed previous run.json

                BETWEEN RUNS: explicit handoff

completed previous run               fresh weekly artifact
selected M7 fields ----------------+  reused as baseline
previous run reference ------------+           |
                                    v           v
                              PriorLearningContext
                                      +
                         MarketplaceVisibilityEvidence
                                      |
                                      v
                          new run -> M1/M2/M4/M5/M6
                                      |
                                      v
                              next experiment plan
```

The same weekly artifact may be referenced by both runs, but it has a different
meaning in each: it is result evidence for the previous experiment and baseline
evidence for the next review. Both runs retain the artifact reference and their
own interpretation. The artifact is not copied or mutated.

> **DDIA lens — derived data and lineage:** One immutable evidence artifact can
> feed two derived decisions when each run records its role and provenance. The
> design reuses the fact without conflating the previous result with the next
> hypothesis.

## Public Command

The first supported command shape is:

```bash
npm run marketplace:next-review -- \
  --profile merchgrid_shopify_app_store \
  --product-ref merchgrid-shopify-app \
  --through YYYY-MM-DD \
  --context artifacts/merchgrid/context/merchgrid-visibility-context.json \
  --listing-context artifacts/merchgrid/context/merchgrid-listing-context.json
```

`--listing-context` remains optional. `--context` may continue to use the
existing environment-backed default. `--through` identifies the completed
weekly review artifact used by the rolling cycle. The command generates run IDs
from the date, profile, and product reference; owners do not supply or retain a
run ID during normal operation.

Daily evidence collection remains explicit or externally scheduled:

```bash
npm run merchgrid:collect -- --date YYYY-MM-DD
```

`next-review` builds or loads the weekly review from already persisted daily
snapshots. If required days are absent, it reports the missing dates and exits
without closing the previous run or creating a new one.

### Interactive confirmation

When no previous run exists, the command starts the first review without asking
about an earlier experiment.

When the latest run contains an experiment plan that has not been resolved, the
command displays only safe identifying information:

```text
Previous experiment: <short M6 revision summary>
Was this experiment applied? [yes/no]
Applied date (YYYY-MM-DD):
```

The date prompt appears only after `yes`. Empty, ambiguous, or invalid input is
rejected; the command does not guess. The prompt boundary is injected so tests
can use deterministic answers without terminal input.

If the owner answers `no`, Buffr records that the plan was not applied and asks
for no rejection reason in the first slice. The absence of a reason prevents
the simplified interface from recreating the removed reject workflow under a
different name.

> **AI Agents in Action lens — human-in-the-loop control:** Whether an
> experiment occurred is a real-world fact only the owner can supply. A model
> may evaluate measured results, but it cannot infer or fabricate this fact.

## Shared Contracts

The exact implementation should follow the repository's Zod-first conventions.
Conceptually, the new and revised contracts are:

```ts
type ProductRef = string; // validated lowercase kebab-case, 3-80 characters

type MarketplaceProductIdentity = {
  profile: 'merchgrid_shopify_app_store' | 'etsy_listing';
  productRef: ProductRef;
};

type ExperimentApplication =
  | { status: 'applied'; appliedAt: UtcDate }
  | { status: 'not_applied'; decidedAt: IsoDateTime };

type PriorLearningContext = {
  sourceRunId: string;
  sourceEvidenceRef: string;
  experimentPlanRef: string;
  outcome: 'win' | 'loss' | 'inconclusive';
  hypothesisEvaluation:
    | 'supported'
    | 'partly_supported'
    | 'not_supported'
    | 'inconclusive';
  learning: string;
  confidence: Confidence;
  nextAction: 'keep' | 'revert' | 'iterate' | 'new_test' | 'research' | 'wait';
  nextActionRationale: string;
};

type RollingReviewInput = {
  identity: MarketplaceProductIdentity;
  through: UtcDate;
  contextPath: LocalArtifactRef;
  listingContextPath?: LocalArtifactRef;
};

type RollingReviewResult = {
  previousRun?: {
    runId: string;
    resolution: 'evaluated' | 'not_applied' | 'already_resolved';
  };
  currentRun: {
    runId: string;
    stage: WorkflowStage;
    status: WorkflowStatus;
    experimentPlanRef?: string;
  };
};

type RollingWorkflowFields = {
  marketplaceIdentity?: MarketplaceProductIdentity; // absent on legacy runs
  experimentApplication?: ExperimentApplication;
  previousRunRef?: string;
  priorLearning?: PriorLearningContext;
};
```

`productRef` is safe internal identity, not a Shopify identifier, shop domain,
URL, credential, or customer value. It is added to curated marketplace context,
normalized visibility evidence, and workflow run state. A product name may
change while `productRef` remains stable. To preserve legacy readability, the
base persisted schemas accept an absent `productRef`; a separate rolling-review
input schema requires it before the coordinator can query or create a new run.

`PriorLearningContext` is a curated projection, not an embedded historical run.
It includes only validated M7 decision fields and local references needed for
provenance. Credentials, prompts, raw provider payloads, private marketplace
data, full event histories, and arbitrary model text outside the M7 schema are
prohibited.

The new run must persist the prior-learning context or an equivalent validated
snapshot so the exact input to its decision process remains inspectable after a
restart. A bare reference resolved differently later would make the run
non-reproducible.

These fields extend the existing workflow state; they do not replace its
evidence snapshots, module outputs, approval field, or events. The existing
approval field remains readable for legacy marketplace runs and remains
available to other workflow products. New rolling marketplace runs use
`experimentApplication` for the owner's applied/not-applied fact so the new
meaning is not disguised as the old approval command.

## Product Identity and Run Lookup

For rolling reviews, curated context requires a `productRef`. This identity
excerpt omits the existing product-description fields, which remain required:

```json
{
  "productRef": "merchgrid-shopify-app",
  "marketplace": "shopify_app_store",
  "productName": "MerchGrid"
}
```

The legacy-readable base context and evidence schemas accept an absent
`productRef`. A strict rolling-review boundary refines those shapes and requires
the field before any repository lookup. The same value must appear in command
input, context, normalized evidence, and run state. A mismatch between command
input, context, listing-context profile, evidence, or previous run fails before
either run is mutated.

`RunRepository` gains a narrow query such as:

```ts
findLatestByProduct(identity: MarketplaceProductIdentity):
  Promise<WorkflowRunState | undefined>;
```

The JSON-file repository implements the query by listing run directories,
loading each candidate through `WorkflowRunStateSchema`, filtering by exact
profile and `productRef`, and ordering by `createdAt` with `runId` as a stable
tie-breaker. Corrupt or invalid candidates cause a storage error rather than
being silently skipped.

This scan is appropriate for the current single-owner local store. The
repository interface permits a future database adapter to use a composite
index on `(profile, product_ref, created_at)` without changing the coordinator.

> **DDIA lens — system of record and secondary indexes:** `run.json` remains the
> source of truth. The first slice derives lookup results directly from those
> records instead of maintaining a second file that could become inconsistent.
> A database index can accelerate the same query later without changing its
> meaning.

## Rolling-Cycle Rules

The coordinator applies these rules in order:

1. Parse command input, context, product identity, and completed `through`
   date.
2. Load or build the weekly review from persisted snapshots without changing
   any workflow run.
3. Validate the weekly artifact's date, subject identity, coverage metadata,
   and usable numeric signals.
4. Find the latest run for the exact `profile + productRef` identity.
5. If no run exists, create and advance the first review using the weekly
   artifact as initial evidence.
6. If the latest run is awaiting an owner decision, ask whether the experiment
   was applied.
7. If not applied, record an `experiment.not_applied` event, set the run to a
   terminal stopped state, and omit M2 Results and M7.
8. If applied, validate `appliedAt` against the previous run and evidence
   windows, record the application fact, supply the weekly artifact as result
   evidence, and advance M2 Results and M7 to completion.
9. If the latest run already completed with M7, reuse its validated learning
   without asking the application question again.
10. If the latest run is in a research or insufficient-data wait unrelated to
    owner application, stop with a precise status message. Do not skip it and
    do not start a competing run.
11. Build a bounded prior-learning context only from a completed M7 output.
    `not_applied` runs contribute no outcome learning.
12. Create one new run with a new ID, the fresh weekly evidence, and the
    optional prior-learning context; then advance it through the existing
    marketplace visibility modules until it reaches a wait, stop, or experiment
    plan.

The previous run must be durably resolved before the new run is created. This
ordering prevents a new recommendation from appearing while the old run still
claims to await an owner decision. If new-run creation fails afterward, retrying
the command recognizes the resolved previous run and attempts only the missing
new-run creation.

## How Prior Learning Affects Modules

Prior learning is context, not authority. M1 may summarize it, M4 may avoid
repeating a disproven diagnosis, M5 may refine or deliberately replace the old
hypothesis, and M6 may define a different test. Deterministic code continues to
decide readiness, routing, research limits, and legal state transitions.

The prompt/instruction stack must state:

- fresh evidence is the current observation and may contradict old learning;
- one previous M7 result is not universal truth;
- source dates and confidence must remain visible;
- a prior win does not prove causality outside its measured window;
- the new recommendation must still change one listing element at a time; and
- the model cannot apply an experiment or initiate another cycle.

Only the latest evaluated run is included in the first slice. Multi-run
retrieval, ranking, summarization, and long-term memory are deferred.

> **AI Agents in Action lens — bounded memory:** The model receives one
> validated learning record with provenance rather than an unbounded history.
> This gives continuity without allowing stale or unrelated runs to dominate
> the next decision.

## Idempotence and Failure Behavior

The cycle key is deterministic:

```text
profile + productRef + through
```

The generated current run ID includes a sanitized product reference and the
`through` date. Before creation, the coordinator checks whether that cycle
already exists. Repeating the command with the same inputs returns the existing
current run after validating its identity; it does not duplicate M2, M7,
research calls, events, or a new experiment plan.

Failure rules:

| Condition | Behavior |
| --- | --- |
| Weekly artifact or daily coverage is missing | Report exact missing evidence; mutate no run |
| Context `productRef` disagrees with command input | Validation error; mutate no run |
| Previous run belongs to another profile or product | Never select it |
| Owner provides invalid or future `appliedAt` | Validation error; leave previous run awaiting decision |
| Result window begins before or on `appliedAt` | Wait for a qualified later window; do not run M7 |
| Previous run is waiting on unresolved research/data | Report the wait; do not start another run |
| Previous run is `not_applied` | Start the next run without prior M7 learning |
| Previous run already has M7 | Reuse its validated learning; do not evaluate again |
| Previous run closes but new-run creation fails | Retry creates only the missing new run |
| Interactive input ends or is cancelled | Exit without changing workflow state |

No model or heuristic resolves these conditions. Dates, identities, run states,
and retry decisions remain deterministic.

## Persistence and Events

Each experiment keeps a separate directory. The previous run records either:

- `experiment.applied` with the validated date, followed by result evidence,
  M2 Results, M7, and `workflow.completed`; or
- `experiment.not_applied`, followed by a terminal stopped state.

The new run records:

- its `productRef` and marketplace profile;
- its optional `previousRunRef`;
- its optional bounded prior-learning snapshot;
- the shared weekly artifact reference in the initial-evidence role; and
- the normal M1-M6, M3, routing, and wait events.

`run.json` remains authoritative. `events.jsonl`, evidence files, and
`experiment-plan.json` remain derived projections. The coordinator emits no
credentials, private customer data, raw provider payloads, prompts, or private
dashboard URLs.

## Command and Code Removal

The implementation removes these marketplace package scripts:

```text
marketplace:visibility-review
marketplace:approve
marketplace:reject
marketplace:record-result
```

It adds only:

```text
marketplace:next-review
```

The marketplace CLI's old command branches and command-specific usage text are
removed. Tests that exist only to assert those public handlers are deleted or
rewritten around `next-review`. README examples and the root `TODO.md` are
updated so the removed commands do not appear as supported marketplace
operations. Historical specifications and retained run artifacts may still name
the commands as facts about the old design; removal checks exclude those
immutable records.

Shared source files are retained when the new coordinator or another product
still uses them. In particular, the workflow engine's internal approval,
result-resume, routing, persistence, M2 Results, and M7 capabilities must not be
removed if MerchGrid workflows or `next-review` still depend on them. The
implementation plan must use repository search to distinguish obsolete public
surface from shared domain behavior before deleting a file.

Existing local run folders remain readable. This design does not rewrite or
delete historical artifacts.

## Migration of Existing Runs

Existing runs lack `productRef`, so they cannot be selected automatically by
the new query without guessing. The first slice uses an explicit, safe rule:

- base persisted context, evidence, and run schemas accept optional
  `productRef` so old records remain readable;
- the rolling-review input validator requires `productRef`, so every new rolling
  run contains it;
- the rolling coordinator ignores old runs without `productRef`; and
- the first `next-review` invocation for a product starts a new rolling history.

There is no filename-based, product-name-based, or date-based inference and no
automatic backfill. An optional explicit migration tool may be designed later
if retaining old runs in rolling lookup becomes valuable.

## Security and Privacy Boundaries

- `productRef` is curated lowercase kebab-case and cannot contain URLs, path
  traversal, provider domains, credential-like keys, or private identifiers.
- The interactive response is runtime-validated before it changes a run.
- Fresh evidence comes only from existing normalized source-pack artifacts.
- The coordinator never queries a private Shopify page or accepts raw exports.
- Only aggregate numeric signals and curated public listing context enter the
  workflow.
- Prior learning is projected through a strict schema before entering a new
  run or model context.
- M3 remains read-only and bounded by its existing tool, domain, call, time,
  token, and cost policies.
- Marketplace changes remain manual even when M7 recommends `keep`, `revert`,
  `iterate`, or `new_test`.

## Testing Strategy

All tests use fake prompts, fixed clocks, local temporary directories, fake
agent runners, and persisted fixtures. They make no real OpenAI, Shopify,
PostHog, Fly, Etsy, or other network calls.

Required test layers:

1. **Contract tests** validate `productRef`, product identity, application
   decisions, prior-learning projections, and prohibited fields.
2. **Repository tests** find the latest exact profile/product match, apply the
   ordering tie-breaker, reject corrupt candidates, and ignore legacy runs
   without a product reference.
3. **Coordinator tests** cover first run, applied prior experiment, not-applied
   prior experiment, already-completed prior run, missing evidence, unresolved
   waits, identity mismatch, and failure between previous-run closure and
   new-run creation.
4. **Idempotence tests** repeat the same cycle and prove there is one M2 result,
   one M7 result, one new run, and no duplicate events or model calls.
5. **CLI tests** inject prompt answers, verify cancellation is non-mutating, and
   confirm output contains only safe run and artifact references.
6. **Agent/module tests** prove the bounded prior-learning context is included
   and that invalid or prohibited historical data never reaches the runner.
7. **End-to-end tests** persist a previous plan, confirm it as applied, close it
   with a fake weekly artifact, start the next run, and verify both independent
   `run.json` records and their lineage references.
8. **Removal checks** search package scripts, CLI parsing, tests, and docs to
   confirm the four obsolete marketplace commands are no longer supported.

## Observability

The rolling coordinator adds business events sufficient to explain the cycle:

```text
rolling_review.started
rolling_review.previous_run_found
experiment.applied
experiment.not_applied
rolling_review.previous_run_evaluated
rolling_review.prior_learning_selected
rolling_review.next_run_created
rolling_review.completed
```

Events contain run IDs, local artifact references, safe product identity, and
dates only. They do not copy complete M7 prose into event data; the authoritative
module output remains in `run.json`.

The OpenAI Agents SDK tracing integration documented in the README remains
separate.
If implemented later, SDK trace IDs may correlate model execution with these
business events, but provider trace data does not become the workflow source of
truth.

## Alternatives Considered

### Keep the four commands as advanced aliases

Rejected by product decision. It preserves backward compatibility but leaves
two ways to operate the same lifecycle and keeps the command-selection burden
the design is meant to remove.

### Require `--previous-run-id`

Rejected for the normal workflow. It avoids repository lookup but requires the
owner to manage the same run identifiers that currently cause confusion.

### Reuse one run forever

Rejected. It makes the command surface small but mixes multiple hypotheses,
evidence windows, approvals, results, and learning records in one growing
aggregate. Separate runs give each experiment a clear audit and retry boundary.

### Infer whether the experiment was applied

Rejected. A metric change cannot prove that the owner changed the listing, and
the system must not manufacture a causal boundary. The interactive human
confirmation is required when an unresolved plan exists.

### Persist a local product-run index immediately

Deferred. A secondary index improves lookup speed but creates another file that
must remain consistent with `run.json`. Validated directory scanning is simpler
at current scale; a future database can implement the same repository query
with an index.

## Acceptance Criteria

The design is implemented successfully when:

1. The documented marketplace lifecycle uses only
   `marketplace:next-review`.
2. A first invocation creates and advances a new visibility run from qualified
   weekly evidence.
3. A later invocation finds only the latest run matching exact
   `profile + productRef`.
4. The owner must explicitly state whether and when the previous experiment was
   applied.
5. Applied experiments receive qualified result evidence, M2 Results, and M7
   exactly once before the next run begins.
6. Not-applied experiments close without fabricated results or M7 learning.
7. The same immutable weekly artifact can be traced as previous-run result
   evidence and next-run initial evidence.
8. The new run receives only a validated, bounded prior-learning context.
9. Repeating a cycle command is idempotent and never duplicates a run, agent
   call, event, or artifact.
10. Old marketplace lifecycle scripts and handlers are removed while shared
    engine behavior used elsewhere continues to pass its tests.
11. Historical run folders are not deleted or rewritten.
12. No automated marketplace write, raw provider data, private customer data,
    credential, prompt, or production URL is introduced into persisted state,
    traces, fixtures, or tests.

## Deferred After This Design

- Etsy rolling result collection.
- More than one prior-learning record in a new run.
- Semantic retrieval or ranking across historical learning.
- A database-backed run repository and composite product-history index.
- A migration command for assigning product references to legacy runs.
- Scheduled daily collection and automatic notification when a weekly window is
  ready.
- A dashboard or graphical owner-confirmation flow.
- Automatic marketplace edits, which remain outside Buffr's safety boundary.
