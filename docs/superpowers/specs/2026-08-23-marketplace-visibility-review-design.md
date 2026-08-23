# Marketplace Visibility Review Design

**Date:** 2026-08-23
**Status:** Proposed design, pending review
**Depends on:** `docs/superpowers/specs/2026-08-23-merchgrid-workflow-integration-design.md`, `docs/superpowers/specs/2026-08-20-merchgrid-business-review-aggregation-design.md`, and `docs/superpowers/specs/2026-08-12-etsy-workflow-engine-design.md`

## Goal

Add a scarce-data recommendation path for marketplace visibility. When Buffr
cannot make a metric-backed recommendation because usage, traffic, or business
data is too sparse, it can still produce a clearly labeled exploratory
visibility review: what might make the product or listing easier to find,
understand, trust, and try.

The first use case is MerchGrid visibility in the Shopify App Store. The design
must also fit Etsy digital products later, without pretending that Shopify App
Store and Etsy have the same evidence model. Buffr should keep one shared
visibility-review workflow with product-specific profiles.

This is not a replacement for weekly business recommendations. The weekly path
uses measured aggregate evidence and comparison windows. The marketplace
visibility path uses sparse evidence plus product context to generate
hypotheses for human-approved tests.

> **DDIA lens — missing-data semantics:** "Not enough measured data" is still
> information. This design preserves that fact instead of turning it into a
> fake zero, a fake trend, or a blocked system. The recommendation is labeled as
> exploratory because the input is sparse.

## Why This Exists

The current MerchGrid daily investigation command can return
`collect_more_data`. That is correct for operational reliability: if there are
too few Fly requests, Buffr should not diagnose a production issue. The same
answer is less satisfying for business visibility. Early products often need
listing, positioning, onboarding, screenshot, tutorial, and keyword ideas before
there is enough traffic to compare week over week.

The existing workflow engine already has the useful pieces: persisted evidence,
deterministic routing, bounded agent modules, experiment plans, approval waits,
and later result learning. What is missing is a new evidence profile and entry
path for scarce-data marketplace visibility.

> **APOSD lens — separate easy and hard decisions:** The easy part is deciding
> that scarce data cannot prove a metric-backed change. The harder part is
> still helping the owner choose a careful next test. Keeping those as separate
> paths makes the system easier to reason about.

## Scope

This design adds:

1. A generic `marketplace_visibility_review` workflow kind.
2. A strict scarce-data visibility evidence contract.
3. Product-specific visibility profiles, starting with MerchGrid and designed
   to allow Etsy later.
4. Deterministic readiness rules that permit exploratory recommendations only
   when the evidence is safe and clearly labeled as sparse.
5. Agent-assisted M1-M6 interpretation that produces a visibility hypothesis
   and test plan, with human approval before any real-world action.
6. A later result path that can compare the approved visibility test against a
   later weekly review or platform-specific outcome evidence.

## Non-goals

- Claiming that sparse evidence proves the recommendation.
- Bypassing the existing metric-backed weekly recommendation path.
- Automatically editing Shopify App Store listings, Etsy listings, images,
  pricing, tutorials, or marketplace settings.
- Scraping Shopify App Store, Etsy, or Meta Marketplace pages.
- Building a broad SEO platform, keyword database, content generator, or
  marketing dashboard.
- Requiring Google Analytics, Shopify Partner CSV, or Etsy traffic data before
  an exploratory visibility review can run.
- Generalizing every future marketplace in the first implementation. The first
  working slice is MerchGrid; Etsy is preserved as an explicit future profile.

## Architecture

### Terms and design patterns

| Term / pattern | Meaning in this design |
| --- | --- |
| Scarce-data mode | A workflow path that can recommend a test even when metrics are insufficient, as long as it labels the evidence level honestly. |
| Marketplace visibility profile | Product-specific adapter that turns platform context into a shared visibility evidence shape. |
| Strategy pattern | The shared workflow calls a profile-specific strategy for MerchGrid now and Etsy later. |
| Anti-corruption layer | Shopify App Store fields, Etsy listing fields, and future platform terms are translated before entering the shared workflow. |
| Human-in-the-loop approval | Buffr proposes a visibility test; the owner decides whether to apply it manually. |

### System Flow

```text
                         MARKETPLACE SOURCES

     MerchGrid / Shopify App Store          Etsy digital product (future)
     product context                         listing context
     sparse PostHog/Fly evidence             Etsy listing evidence
     known limitations                       marketplace constraints
                 |                                      |
                 v                                      v
       +----------------------+              +----------------------+
       | MerchGrid visibility |              | Etsy visibility      |
       | profile              |              | profile              |
       +----------+-----------+              +----------+-----------+
                  \                                  /
                   \                                /
                    v                              v
              +------------------------------------------+
              | Marketplace visibility evidence contract |
              | evidenceLevel: sparse                    |
              | recommendationType: visibility_hypothesis |
              | limitations retained                     |
              +--------------------+---------------------+
                                   |
                                   v
              +------------------------------------------+
              | Existing Buffr workflow engine           |
              | M1 context -> M2 evidence label          |
              | M4 diagnosis -> M5 hypothesis -> M6 test |
              | approval_wait -> manual action           |
              +--------------------+---------------------+
                                   |
                                   v
              +------------------------------------------+
              | Later evidence loop                      |
              | collect again -> compare -> M7 learning  |
              +------------------------------------------+
```

The source pack still owns measured data collection. The visibility profile
owns product and marketplace context. The workflow engine owns lifecycle,
approval, persistence, and learning. The agent modules may interpret and
propose, but they do not query providers or apply changes.

> **DDIA lens — derived data and provenance:** A visibility review is derived
> evidence. It must retain where its context came from, what is missing, and why
> its confidence is exploratory. That provenance prevents a future reader from
> confusing a heuristic recommendation with a measured result.

> **AI Agents in Action lens — bounded specialist:** The agent's job is not to
> decide whether sparse evidence is enough. Code decides the evidence label and
> allowed action boundary. The agent only turns approved context into a
> structured visibility hypothesis and test plan.

## Contracts and Data Flow

The workflow-facing contract is conceptually:

```ts
type MarketplaceVisibilityEvidence = {
  product: 'marketplace_visibility';
  profile: 'merchgrid_shopify_app_store' | 'etsy_listing';
  subjectRef: string;
  artifactRef: string;
  evidenceLevel: 'sparse';
  recommendationType: 'visibility_hypothesis';
  marketplaceContext: {
    marketplace: 'shopify_app_store' | 'etsy';
    productName: string;
    currentSurfaceSummary: string;
    targetAudience?: string;
    knownDiscoverySurface?: string;
  };
  measuredSignals: Record<string, number>;
  limitations: string[];
  prohibitedClaims: string[];
};
```

For MerchGrid, `measuredSignals` can include safe aggregates from the daily or
weekly artifacts, such as app opens, scan starts, scan completions, requests,
and error rate. It should not include shop domains, merchant identities,
catalog records, provider payloads, raw events, or credentials.

For Etsy later, the profile can include listing title, tags, category, price,
photo-count metadata, and safe aggregate listing stats if available. It should
not force Etsy into the MerchGrid source-pack shape.

The data flow is:

1. A daily or weekly path returns `collect_more_data`, or the user explicitly
   asks for a visibility review.
2. A product-specific profile loads available safe context and sparse measured
   signals.
3. Deterministic code creates `MarketplaceVisibilityEvidence` with
   `evidenceLevel: 'sparse'`.
4. M1 summarizes the product, marketplace, audience, and missing facts.
5. M2 marks metric support as limited and names which measurements are missing.
6. M4 diagnoses likely visibility bottlenecks without claiming proof.
7. M5 proposes one visibility hypothesis.
8. M6 defines a small manual test and success signal.
9. The engine stops at `approval_wait`.
10. After the owner manually applies a change and collects later evidence, M7
    records what was learned.

> **Fundamentals of Data Engineering lens — data quality:** This path treats
> sparse evidence as a data-quality state. The output is useful because it is
> honest about quality, not because it pretends the data is complete.

## Workflow Behavior

### Entry Criteria

The visibility review may start when at least one of these is true:

- daily investigation returns `collect_more_data`;
- weekly recommendation returns `collect_more_data`;
- the owner explicitly requests a visibility review for a product or listing;
- there is enough product context to form a safe visibility hypothesis.

The profile must also provide enough context to avoid generic advice. For
MerchGrid, that means at least product name, marketplace, current listing or
positioning summary, known limitations, and any safe aggregate metrics already
collected.

### Valid Outcomes

| Outcome | Meaning |
| --- | --- |
| `visibility_review_ready` | Buffr created a hypothesis and test plan, now waiting for owner approval. |
| `visibility_context_missing` | Product context is too thin to produce a grounded recommendation. |
| `visibility_review_rejected` | Owner rejected the proposed test. |
| `visibility_experiment_wait` | Owner approved the test and will apply it manually. |
| `visibility_learning_complete` | Later evidence was supplied and M7 recorded the result. |

### Recommendation Rules

Every visibility recommendation must include:

1. evidence level: `sparse`;
2. one primary visibility hypothesis;
3. what the hypothesis is based on;
4. what evidence is missing;
5. one manual test;
6. the success signal to watch later;
7. a warning that the recommendation is exploratory.

The recommendation must not say "this will increase installs" or "this proves
the listing is the problem." It may say "test whether clearer screenshots and
first-scan copy improve app opens or scan starts."

> **Release It lens — production safety:** A recommendation can be wrong
> without taking the system down, but an automatic change can still damage a
> live product. The manual approval boundary keeps exploratory suggestions from
> becoming unreviewed production changes.

## Module Responsibilities

| Stage / component | Responsibility | Deterministic or agent-assisted | Inputs | Outputs |
| --- | --- | --- | --- | --- |
| Visibility profile | Translate product-specific context into shared evidence | Deterministic | MerchGrid or Etsy context | `MarketplaceVisibilityEvidence` |
| Readiness gate | Decide whether sparse review is allowed | Deterministic | Visibility evidence | Ready or context-missing |
| M1 context | Summarize product, marketplace, audience, missing facts | Deterministic or agent-assisted | Visibility evidence | Context output |
| M2 evidence label | Mark comparison quality as sparse, name missing measurements | Deterministic | Visibility evidence | Metrics output with limited quality |
| M4 diagnosis | Identify likely visibility bottleneck | Agent-assisted | Context and sparse evidence | Diagnosis output |
| M5 hypothesis | Propose one visibility hypothesis | Agent-assisted | Diagnosis | Hypothesis output |
| M6 test plan | Define manual test and success signal | Agent-assisted | Hypothesis | Test plan output |
| Approval gate | Require owner decision | Deterministic | M6 output | Approved, rejected, or waiting |
| M7 learning | Evaluate later evidence against the approved test | Agent-assisted after deterministic metrics | Later evidence | Learning output |

## Persistence, Tracing, and Idempotence

Visibility reviews persist as normal workflow runs under the local run
repository. The run stores initial evidence, events, module outputs, approval
state, and the final experiment plan. It does not store provider credentials,
raw marketplace pages, raw event payloads, shop domains, customer data, or
catalog records.

Run ids must remain explicit and safe, such as:

```text
merchgrid-visibility-2026-08-22
etsy-visibility-listing-123
```

If the same visibility evidence is reviewed again with the same run id, the
repository should reject accidental overwrite. If the owner wants another pass,
they create a new run id so the earlier reasoning remains historically intact.

> **DDIA lens — immutable history:** A recommendation is part of the decision
> log. Reusing old evidence under a new run id is acceptable; silently
> overwriting the old recommendation is not.

## Failure Handling and Safety

| Condition | Deterministic behavior |
| --- | --- |
| Missing product context | Return `visibility_context_missing`; do not call agents. |
| Sparse metrics | Allow visibility review only with `evidenceLevel: sparse`. |
| Missing Shopify CSV | Keep limitation; do not block MerchGrid visibility review. |
| Missing PostHog/Fly values | Keep limitation; do not invent values. |
| Agent output fails schema | Stop or wait with validation error; do not persist partial proposal as approved. |
| Human rejects proposal | Persist rejection and stop run. |
| Human approves proposal | Move to experiment wait; do not change external systems. |
| Later evidence is insufficient | Preserve approved plan and wait for more data. |

## Testing Strategy

1. Contract tests reject credentials, raw payloads, provider URLs, and unknown
   private fields.
2. Readiness tests prove sparse evidence is accepted only as sparse evidence.
3. MerchGrid profile tests build visibility evidence from a daily artifact that
   returned `collect_more_data`.
4. Etsy fixture tests prove a future listing profile can use the same shared
   contract without Shopify/Fly/PostHog fields.
5. Workflow route tests prove the review reaches `approval_wait`, not
   `experiment_wait`.
6. Rejection and approval tests prove no provider write occurs.
7. Result-path tests prove later evidence can be attached without rewriting the
   original scarce-data recommendation.

## Decisions and Deferred Work

| Decision | Rationale | Deferred |
| --- | --- | --- |
| Make this generic marketplace visibility, not MerchGrid-only | The same scarce-data problem applies to Shopify App Store and Etsy listings. | Meta Marketplace profile. |
| Keep metric-backed weekly recommendation separate | Sparse recommendations and measured recommendations have different evidence quality. | Merging outputs into one dashboard. |
| Allow recommendations with sparse evidence | Early products need action before they have statistically useful traffic. | Automated confidence scoring from larger data sets. |
| Require human approval | Visibility changes affect real listings and product positioning. | Automatic listing edits. |
| Start with product context plus safe aggregates | It is enough for a first exploratory review. | Web research, competitor analysis, GA4 listing traffic, keyword data. |

## Done Means

1. A new `marketplace_visibility_review` workflow kind exists.
2. MerchGrid can start a visibility review from a daily artifact that returned
   `collect_more_data`.
3. The run persists sparse evidence and limitations.
4. M1-M6 produce a single visibility hypothesis and manual test plan.
5. The run stops at `approval_wait`.
6. Rejected runs stop and approved runs move to `experiment_wait`.
7. No command applies external marketplace changes.
8. Etsy has a fixture-backed profile test proving the shared contract is not
   MerchGrid-only.

## Final Self-Review

This spec intentionally separates measured weekly recommendations from sparse
visibility reviews. It labels scarce data as scarce, preserves the existing
human approval boundary, and keeps provider collection outside workflow
modules. No credentials, raw provider payloads, private shop/customer data, or
automatic external writes are part of the design.
