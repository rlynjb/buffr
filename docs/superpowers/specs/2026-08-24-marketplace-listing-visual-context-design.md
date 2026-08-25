# Marketplace Listing Visual Context Design

**Date:** 2026-08-24
**Status:** Proposed design, pending review
**Extends:** `docs/superpowers/specs/2026-08-23-marketplace-visibility-review-design.md`
**Extends:** `docs/superpowers/specs/2026-08-24-marketplace-visibility-zero-data-review-design.md`

## Goal

Add public marketplace listing context to Buffr's marketplace visibility review
so sparse-data recommendations can account for how a product looks and reads on
its discovery surface.

The first target is the public Shopify App Store listing for MerchGrid:

`https://apps.shopify.com/merchgrid-catalog-audit`

This design lets Buffr use listing URL, copy, screenshots, trust signals,
category placement, and visual-review notes as qualitative evidence. It does
not automate marketplace edits. It does not claim that visual/copy observations
prove why views or installs are low. It gives M4-M6 better context for a safe
exploratory visibility test.

> **DDIA lens — context is data with provenance:** A marketplace page is not a
> metric stream, but it is still evidence. Buffr should record where the
> observation came from, when it was captured, and which fields were observed so
> the work engine can distinguish "measured behavior" from "curated product and
> listing context."

## Why This Exists

Zero-data marketplace visibility mode works when Buffr has enough curated
product context. The next missing piece is the actual surface a buyer or
merchant sees before deciding whether to click, install, or try the product.

For MerchGrid, sparse metrics alone can say:

- there are few or no app opens;
- there may be too little Shopify Partner history;
- PostHog has only early app usage signals;
- visibility cannot be diagnosed from metrics yet.

The public listing adds a different kind of evidence:

- what the headline promises;
- whether the screenshots make the outcome obvious;
- whether the listing explains risk and safety clearly;
- whether reviews, pricing, category, support, and data access create or reduce
  trust friction;
- whether the page tells the right user what action to take next.

> **APOSD lens — deepen the interface, not the workflow:** The workflow engine
> should not know how to inspect Shopify pages, Etsy listings, or Meta
> Marketplace posts. A listing-context adapter turns those external surfaces
> into one small, stable contract. The engine then keeps doing what it already
> does: diagnose, hypothesize, design an experiment, and wait for human
> approval.

## Scope

This design adds:

1. A local listing-context contract for marketplace visibility reviews.
2. A public listing URL field on the visibility brief.
3. A browser-assisted visual review workflow for the first implementation.
4. Optional captured screenshot metadata and structured visual notes.
5. M4 guidance that treats listing context as qualitative evidence, not proof.
6. M5/M6 behavior that can recommend one manual listing test when metrics are
   sparse but product and listing context are sufficient.

## Non-goals

- Automatically editing Shopify App Store listings, Etsy listings, or Meta
  Marketplace posts.
- Building a general web scraper.
- Storing raw HTML, cookies, session data, authenticated dashboard pages, or
  private marketplace data.
- Treating a visual review as conversion proof.
- Requiring a screenshot for every run when text context is enough.
- Replacing PostHog, Shopify Partner CSV, Fly metrics, or future platform
  analytics.
- Downloading or committing captured marketplace screenshots by default.

## Current MerchGrid Listing Observations

As of 2026-08-24, the public Shopify App Store listing exposes enough
non-authenticated context for a first visual/copy review:

- app name: `MerchGrid: Catalog Audit`;
- price: free;
- rating: `0.0 (0 Reviews)`;
- developer: `buffrstudio`;
- gallery images: main image plus onboarding, progress, and result images;
- headline: `Scans your product catalog and shows exactly which items are priced below cost.`;
- category: Analytics;
- feature area: Visuals and reports / Analytics dashboard;
- visible bullets: below-cost and low-margin pricing, compare-at price issues,
  duplicate and missing SKUs;
- support and privacy policy links;
- launch date: August 7, 2026;
- data access disclosure for store owner and products.

This is enough for Buffr to reason about clarity, trust, and first-action
friction without needing private Partner Dashboard data.

> **DDIA lens — source freshness:** Listing context is time-sensitive. The
> contract must record `capturedAt` and `sourceUrl`, because a recommendation
> made from last month's listing may not explain this week's result.

## Architecture

The marketplace visibility review keeps the same core workflow. Listing context
becomes another local evidence input before M4 diagnosis.

```text
+---------------------------+
| Public marketplace page  |
| Shopify / Etsy / Meta    |
+-------------+-------------+
              |
              | browser-assisted observation
              | public fields only
              v
+---------------------------+
| Listing context capture   |
| URL, copy, screenshots,   |
| trust signals, notes      |
+-------------+-------------+
              |
              v
+---------------------------+        +---------------------------+
| Local listing context     |        | Existing product brief    |
| artifacts/.../listing-    |        | artifacts/.../visibility- |
| context.json              |        | context.json              |
+-------------+-------------+        +-------------+-------------+
              |                                    |
              +----------------+-------------------+
                               |
                               v
                  +---------------------------+
                  | Marketplace visibility    |
                  | evidence builder          |
                  | measured + qualitative    |
                  +-------------+-------------+
                                |
                                v
                  +---------------------------+
                  | Existing work engine      |
                  | M4 diagnosis              |
                  | M5 hypothesis             |
                  | M6 experiment plan        |
                  +-------------+-------------+
                                |
                                v
                  +---------------------------+
                  | approval_wait             |
                  | owner manually applies or |
                  | rejects listing test      |
                  +---------------------------+
```

The important seam is:

```text
Provider-specific page
  -> listing-context capture
  -> MarketplaceListingContext
  -> MarketplaceVisibilityEvidence
  -> work engine
```

Everything before `MarketplaceListingContext` can vary by marketplace.
Everything after it should stay shared.

## Contract

The first implementation should add a strict local JSON contract.

```ts
type MarketplaceListingContext = {
  marketplace: 'shopify_app_store' | 'etsy' | 'meta_marketplace';
  profile: 'merchgrid_shopify_app_store' | 'etsy_listing' | 'meta_marketplace_listing';
  productName: string;
  sourceUrl: string;
  capturedAt: string;
  captureMode: 'manual_visual_review' | 'browser_assisted_public_page';
  publicSurface: {
    title?: string;
    subtitle?: string;
    headline?: string;
    shortDescription?: string;
    category?: string;
    pricingLabel?: string;
    ratingSummary?: string;
    reviewCount?: number;
    launchDate?: string;
  };
  gallery: {
    imageCount: number;
    observedImageLabels: string[];
    visualNotes: string[];
  };
  trustSignals: {
    positive: string[];
    friction: string[];
  };
  copyNotes: {
    clearClaims: string[];
    unclearClaims: string[];
    missingContext: string[];
  };
  visibilityRubricNotes: {
    promiseClarity: string;
    audienceSpecificity: string;
    problemActionFit: string;
    discoveryFit: string;
    trustAndRiskReduction: string;
    assetClarity: string;
  };
  limitations: string[];
};
```

The listing context should be local and ignored when it contains subjective
working notes. A safe example file can be committed under `docs/examples/`.

> **DDIA lens — schema-on-write:** The capture step should validate the listing
> context before the workflow run starts. That prevents loose notes from leaking
> into M4 as ambiguous prompt text.

## Data-Flow Rules

1. `sourceUrl` must be public `https`.
2. The loader must reject local paths outside the repository and any URL that
   is not explicitly passed by the owner.
3. The context must not include cookies, auth headers, storefront session data,
   private Partner Dashboard pages, private merchant data, or raw HTML dumps.
4. Screenshots are optional. If captured, store only local artifact references
   and short visual notes unless the owner explicitly asks to keep images.
5. The evidence builder should attach listing context by reference and selected
   normalized fields, not by copying large blobs into every run file.
6. M4 must label visual observations as hypotheses or constraints, not measured
   facts.

## How M4-M6 Should Use It

### M4 diagnosis

M4 should compare sparse metrics, product brief, and listing context. It can
identify a likely visibility bottleneck such as:

- unclear promise;
- weak audience specificity;
- missing risk-reduction copy;
- screenshots that do not show the outcome quickly;
- mismatch between category/search intent and copy;
- missing first-action explanation.

M4 must not say the listing definitely caused low views. It should say the
listing context suggests a safe place to test.

### M5 hypothesis

M5 should convert the bottleneck into one focused visibility hypothesis.

Example:

```text
If the Shopify App Store listing makes the read-only catalog-audit outcome
clearer in the headline and first screenshot, then more qualified merchants may
open the app and start a first scan.
```

### M6 experiment plan

M6 should produce a manual test plan:

- one listing element to change;
- one primary signal to watch;
- supporting and weakening signals;
- what must stay constant;
- when the result is inconclusive;
- human approval required before changing the listing.

> **Release It! lens — safe operational change:** A listing experiment is still
> a production-facing change. Keep it small, reversible, and observable. Do not
> change copy, screenshots, pricing, and category all at once, or the result
> becomes impossible to interpret.

## Example Local Context Files

For MerchGrid:

```text
artifacts/merchgrid/context/merchgrid-visibility-context.json
artifacts/merchgrid/context/merchgrid-listing-context.json
```

The visibility command can accept the listing context explicitly:

```bash
npm run marketplace:visibility-review -- \
  --profile merchgrid_shopify_app_store \
  --date 2026-08-07 \
  --context artifacts/merchgrid/context/merchgrid-visibility-context.json \
  --listing-context artifacts/merchgrid/context/merchgrid-listing-context.json
```

The existing `--context` remains the product brief. The new
`--listing-context` supplies the observed marketplace surface.

## Failure Modes

| Failure | Behavior |
| --- | --- |
| Listing context file missing | Continue only if product brief is sufficient; record `listing_context_missing` limitation. |
| Listing URL is private or non-HTTPS | Reject the listing context before workflow start. |
| Screenshot capture fails | Continue with text/copy fields and record `screenshot_unavailable`. |
| Listing has changed since capture | Require a fresh `capturedAt` before treating it as current. |
| Visual notes include unsupported claims | Reject or strip the unsafe notes before M4. |
| Metrics are still zero | Continue in exploratory mode if product and listing context are sufficient. |

## Testing Strategy

Add tests at the contract, loader, evidence-builder, and workflow levels.

1. Contract tests validate a safe Shopify listing context.
2. Contract tests reject private URLs, raw HTML, auth-like fields, and unsafe
   notes.
3. Loader tests read a local `.json` file and return typed listing context.
4. Evidence-builder tests attach listing-context references without duplicating
   raw page payloads.
5. Workflow tests prove zero metrics plus product context plus listing context
   reaches `approval_wait`.
6. M4/M5/M6 tests prove listing observations are phrased as exploratory
   hypotheses, not proven diagnoses.

## Acceptance Criteria

- A MerchGrid visibility review can accept a public Shopify App Store listing
  context file.
- The listing URL, capture time, public listing fields, visual notes, trust
  signals, and limitations are preserved in the workflow evidence.
- The run still reaches `approval_wait` when metrics are sparse but product and
  listing context are sufficient.
- `experiment-plan.json` can recommend one manual listing test tied to a
  primary metric such as `app_opened_count`.
- No raw HTML, cookies, credentials, private dashboard data, or marketplace edit
  actions are introduced.
- The design still allows future Etsy and Meta listing profiles through the
  same `MarketplaceListingContext` seam.

## Later Extensions

- Browser-assisted screenshot capture with local artifact references.
- Lightweight competitor listing context, explicitly separated from the owner
  listing.
- Shopify Partner GraphQL data, if an authenticated API path is approved later.
- Etsy listing profile using title, tags, thumbnail count, category, and safe
  listing stats.
- A UI that displays listing context beside M4/M5/M6 reasoning and the
  generated experiment plan.
