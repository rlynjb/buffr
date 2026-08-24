# Marketplace Visibility Zero-Data Review Design

**Date:** 2026-08-24
**Status:** Proposed revision
**Revises:** `docs/superpowers/specs/2026-08-23-marketplace-visibility-review-design.md`
**Related plan:** `docs/superpowers/plans/2026-08-24-marketplace-visibility-zero-data-review.md`

## Goal

Revise marketplace visibility sparse-data mode so Buffr can still recommend a
safe exploratory visibility test when marketplace metrics are zero, sparse, or
too early to diagnose.

The point of this path is not to prove why a marketplace listing is invisible.
The point is to help the owner move from "there is not enough data" to "here is
one low-risk visibility experiment worth trying next," using product context,
marketplace context, and whatever lightweight evidence exists.

> **DDIA lens — missing-data semantics:** Missing data is not the same as a
> zero result. A brand-new product can have no installs because the listing has
> not been exposed, because the value proposition is unclear, because the
> marketplace has low traffic, or simply because the sample is too small. The
> design must preserve that uncertainty while still allowing a careful next
> test.

## Problem

The current sparse-data visibility workflow has the right architecture, but the
runtime path is still too conservative. A real run can stop at M4 with
`collect_more_data` when metrics are sparse. That behavior is correct for
metric-backed operational diagnosis, but it defeats the purpose of a
marketplace visibility review.

For launch-stage products, the expected starting point is often:

- no meaningful install history;
- little or no marketplace traffic;
- no reliable conversion baseline;
- partial platform analytics;
- a need for product-positioning and listing-surface decisions.

In that state, Buffr should not claim proof. It also should not stop simply
because the product is new. It should use a stricter question:

> Do we have enough curated product and marketplace context to recommend one
> safe exploratory visibility test?

If yes, proceed to M5/M6. If no, stop with the exact context fields needed.

> **APOSD lens — separate policy from mechanism:** The workflow engine is the
> mechanism. The zero-data rule is policy. Keeping the policy in a small
> readiness/mode selector avoids burying the decision in prompts or letting each
> agent module reinterpret sparse data differently.

## Scope

This revision adds:

1. A named `exploratory_visibility_test` mode for marketplace visibility runs.
2. A richer local visibility brief that describes the product, marketplace,
   audience, current surface, and owner constraints.
3. A deterministic mode selector that distinguishes sparse metrics from missing
   product context.
4. M4 routing rules that continue to M5/M6 when context is sufficient, even
   when measured marketplace data is sparse.
5. M5 and M6 constraints that label recommendations as exploratory,
   low-confidence, and human-approved only.
6. Tests proving zero metrics plus complete context reaches `approval_wait`,
   while missing context stops with actionable missing fields.

## Non-goals

- Proving a visibility bottleneck from zero metrics.
- Claiming a listing change will increase views, installs, purchases, or scan
  starts.
- Automatically changing Shopify App Store, Etsy, Meta Marketplace, or other
  marketplace surfaces.
- Scraping marketplace pages.
- Requiring Shopify Partner CSV, GA4, Etsy analytics, or PostHog data before a
  first exploratory review can run.
- Building a generic marketing automation platform.
- Replacing the existing metric-backed weekly business review.

## Architecture

The existing marketplace visibility workflow remains the right outer shape.
This revision tightens the seam between evidence preparation and agent
interpretation.

```text
Local product brief
product, audience, promise, surface, constraints
        |
        v
+------------------------------+
| Visibility context loader    |
| strict local JSON only       |
+--------------+---------------+
               |
               v
+------------------------------+       Daily/weekly metrics may be sparse
| Visibility mode selector     |<---------------------------------------+
| - complete brief?            |                                        |
| - safe context?              |                                        |
| - measured evidence level?   |                                        |
+--------------+---------------+                                        |
               |                                                        |
      +--------+---------+                                              |
      |                  |                                              |
      v                  v                                              |
missing_context     exploratory_visibility_test                         |
      |                  |                                              |
      v                  v                                              |
waiting_for_data     MarketplaceVisibilityEvidence                      |
                         mode: exploratory_visibility_test               |
                         evidenceLevel: sparse                          |
                         confidenceBoundary: low                        |
                         |                                              |
                         v                                              |
                  Existing workflow engine                              |
                  M1 -> M2 -> M4 -> M5 -> M6                            |
                         |                                              |
                         v                                              |
                  approval_wait                                         |
                         |                                              |
                         v                                              |
                  owner manually applies or rejects test                 |
```

The important boundary is:

- metrics decide whether a recommendation can be measured;
- product and marketplace context decide whether a safe exploratory test can be
  proposed.

Sparse metrics block confident diagnosis. They do not block a carefully labeled
experiment.

> **DDIA lens — derived data and provenance:** The recommendation is derived
> data. The run must record which product brief, metric artifact, limitations,
> and mode selector result produced it. That keeps future analysis honest when
> the owner later asks, "Why did Buffr suggest this?"

## Visibility Brief

The local context file should evolve from a short summary into a curated
visibility brief. It is still local JSON, still ignored if it contains private
working notes, and still provider-free.

Conceptual shape:

```ts
type MarketplaceVisibilityBrief = {
  marketplace: 'shopify_app_store' | 'etsy' | 'meta_marketplace';
  productName: string;
  productType: 'shopify_app' | 'digital_product' | 'physical_product' | 'service';
  targetCustomer: string;
  customerProblem: string;
  currentPromise: string;
  currentSurfaceSummary: string;
  primaryDiscoverySurface: string;
  primaryActionWanted: string;
  constraints: string[];
  availableAssets: string[];
  ownerGoal: string;
};
```

For MerchGrid, this might describe:

- marketplace: Shopify App Store;
- product type: Shopify app;
- target customer: merchants who need catalog-quality audits;
- current promise: find catalog issues before they cost sales or trust;
- primary action wanted: open app and run first catalog audit.

For an Etsy digital product later, the same shape can describe:

- marketplace: Etsy;
- product type: digital product;
- target customer: buyer persona;
- current promise: what the printable/template helps them do;
- primary action wanted: click listing, favorite, or purchase.

> **APOSD lens — deep module:** The workflow should not know Shopify listing
> fields or Etsy listing fields. A marketplace profile translates each platform
> into this brief. The rest of Buffr sees a small, stable interface.

## Mode Selector

Add an explicit mode selector before M4 interpretation.

```ts
type VisibilityReviewMode =
  | {
      mode: 'exploratory_visibility_test';
      evidenceLevel: 'sparse';
      confidenceBoundary: 'low';
      reason: 'metrics_sparse_context_sufficient';
    }
  | {
      mode: 'missing_context';
      missingFields: string[];
      reason: 'context_required_before_exploratory_test';
    };
```

Required context for the first implementation:

- `productName`
- `productType`
- `targetCustomer`
- `customerProblem`
- `currentPromise`
- `currentSurfaceSummary`
- `primaryDiscoverySurface`
- `primaryActionWanted`
- at least one owner constraint

The selector returns `exploratory_visibility_test` when those fields are present
and safe, even if all measured signals are zero or unavailable.

The selector returns `missing_context` only when Buffr lacks enough curated
product/marketplace context to suggest a responsible next test.

> **DDIA lens — schema-on-write for decisions:** The mode selector writes down
> the interpretation of evidence quality at the time of the run. Future modules
> consume that decision instead of re-deriving it from loose text.

## Visibility Rubric

When mode is `exploratory_visibility_test`, M4 should evaluate the current
surface through a lightweight rubric:

1. **Promise clarity** — can a marketplace visitor understand the value quickly?
2. **Audience specificity** — does the copy say who the product is for?
3. **Problem/action fit** — does the surface connect the problem to the next
   action?
4. **Discovery fit** — does the title/summary align with likely marketplace
   search or browsing intent?
5. **Trust and risk reduction** — does the surface reduce uncertainty for a
   first-time visitor?
6. **Asset clarity** — do screenshots, thumbnails, demos, or examples show the
   outcome?
7. **Measurement readiness** — is there a safe signal to watch after the manual
   change?

M4 can identify one likely visibility bottleneck from this rubric, but it must
label the bottleneck as a hypothesis, not a fact.

> **Fundamentals of Data Engineering lens — data product fitness:** The review
> is useful only if the output is fit for its consumer. The consumer is not a
> dashboard; it is the owner deciding on one next marketplace experiment.

## Module Behavior

### M1 context

M1 should summarize the product brief, current surface, owner goal, available
assets, and limitations. It should not introduce unobserved marketplace facts.

### M2 metrics

M2 should label measured evidence as sparse and list the available signals. If
there are no usable signals, M2 should still produce a valid sparse metrics
output with `comparisonQuality: 'limited'` and unresolved qualification needs.

### M4 diagnosis

M4 should receive the mode selector result. In
`exploratory_visibility_test` mode, it should not choose `collect_more_data`
solely because metrics are sparse. It should choose `proceed_to_hypothesis`
unless the product brief is contradictory or unsafe.

M4 output must include:

- one visibility bottleneck hypothesis;
- one competing explanation;
- low confidence;
- a note that the recommendation is not metric-proven.

### M5 hypothesis

M5 should turn the bottleneck into one testable change. Examples:

- clarify the first value proposition in the listing summary;
- reorder screenshots to show the outcome first;
- adjust the title/subtitle to better match the target customer's search
  language;
- add a short tutorial or "first scan" expectation to reduce adoption friction.

M5 should not propose broad rewrites, multiple simultaneous changes, or external
automation.

### M6 test plan

M6 should create a manual exploratory test plan:

- baseline state to save before the change;
- exact human action to apply;
- what to keep constant;
- earliest reasonable review date;
- weak signals to watch;
- success, weakening, and inconclusive conditions;
- reminder that sparse evidence may remain inconclusive.

> **Release It lens — blast radius:** The plan should prefer a reversible,
> low-risk change. A listing-copy or screenshot-order experiment is safer than
> changing pricing, app functionality, onboarding logic, or production behavior.

## Acceptance Criteria

1. Given zero measured signals and a complete visibility brief, the marketplace
   visibility command reaches `approval_wait`.
2. Given sparse measured signals and a complete visibility brief, M4 returns
   `decision: 'proceed_to_hypothesis'`.
3. Given missing required brief fields, the workflow stops at
   `waiting_for_data` with the exact missing fields.
4. M5 and M6 outputs include low-confidence exploratory language and never
   claim proof or guaranteed marketplace improvement.
5. The workflow still rejects unsafe local context such as tokens, emails,
   shop domains, raw provider payload markers, or scraped page dumps.
6. Existing metric-backed MerchGrid weekly reviews remain unchanged.
7. Existing marketplace visibility result evaluation remains human-gated and
   does not apply marketplace changes automatically.

## Example Outcome

For MerchGrid with no install traction, Buffr may produce:

```text
Exploratory visibility hypothesis:
The Shopify App Store listing may not explain the first-scan value quickly
enough for a merchant who is just browsing catalog-quality tools.

Safe test:
Rewrite the first listing paragraph and first screenshot caption around the
outcome "Find catalog issues before they hurt sales or trust." Keep pricing,
features, screenshots count, and app behavior unchanged. Review app opens and
scan starts after the next completed week.

Confidence:
Low. This is not metric-proven. It is a product-context visibility test for an
early marketplace surface.
```

That is the behavior this revision is meant to make reliable.
