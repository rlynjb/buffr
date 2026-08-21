# MerchGrid Business Review Aggregation Design

**Date:** 2026-08-20
**Status:** Approved design, documentation only

## Goal

Give Buffr one privacy-conscious, source-independent picture of MerchGrid's
business and reliability. The first version produces two outputs from the same
daily data set:

- a concise daily health summary; and
- a weekly business review with week-over-week comparisons and evidence for
  future diagnosis.

## Scope

Buffr will collect small daily aggregates from three existing sources:

| Source | What it contributes | Initial collection mode |
| --- | --- | --- |
| PostHog | `app_opened`, `scan_started`, `scan_completed`, and `scan_failed` counts and scan-completion funnel rates | Automated read-only query |
| Fly Metrics / Grafana | availability, request/error signals, and machine/reliability aggregates | Automated read-only Prometheus query |
| Shopify Partner data | active merchants, installs, uninstalls, and earnings when available | Capability-checked connector; CSV import fallback |

The collection boundary belongs in Buffr. MerchGrid remains the operational
Shopify product and privacy-filtered telemetry producer. It will not gain an
analytics dashboard, a reporting database, or cross-source connectors.

## Non-goals

- Copying raw PostHog events, Shopify catalog records, Fly logs, or personal
  merchant/customer data into Buffr.
- Building a real-time dashboard, alerts, or an internal MerchGrid analytics UI.
- Adding Google Analytics listing-traffic collection.
- Letting an LLM choose source queries, write source data, or control the
  collection lifecycle.
- Replacing the source dashboards as their systems of record.

## Architecture

Buffr follows its existing ports-and-adapters direction: connectors isolate
external API details; the deterministic core consumes normalized evidence.

```text
PostHog ──────────────┐
Fly Prometheus ───────┼──> source adapters ──> daily metric snapshots
Shopify Partner ──────┘                              │
                                                     ├──> daily health summary
                                                     └──> weekly business review
```

The proposed components are:

1. **Source adapters** fetch only an allowlisted aggregate metric set for a
   supplied UTC date window. They return normalized values plus collection
   metadata; they do not expose raw source payloads to the workflow.
2. **Snapshot repository** persists immutable per-source, per-date snapshots.
   A retry replaces only an incomplete or failed snapshot for the same source
   and date; successful snapshots are not silently recomputed.
3. **Metric normalizer** validates units, dates, source identity, and missing
   values before storing a snapshot.
4. **Summary builders** read stored snapshots. The daily builder produces
   reliability status; the weekly builder compares a complete seven-day window
   with the preceding seven-day window.
5. **Workflow integration** treats snapshots and summaries as normalized
   evidence. Buffr's deterministic workflow remains responsible for routing,
   evidence gates, waits, and any later agent-assisted interpretation.

## Data contract

Every stored metric observation has this shape conceptually:

```ts
type DailyMetricSnapshot = {
  source: "posthog" | "fly_metrics" | "shopify_partner";
  date: string; // UTC calendar date, YYYY-MM-DD
  collectedAt: string; // ISO-8601 timestamp
  status: "complete" | "partial" | "unavailable" | "failed";
  metrics: Record<string, number>;
  notes: string[]; // bounded operational labels, never source payloads
};
```

The initial metric names are deliberately small:

| Source | Metrics |
| --- | --- |
| PostHog | `app_opened_count`, `scan_started_count`, `scan_completed_count`, `scan_failed_count`, `scan_completion_rate` |
| Fly Metrics | `request_count`, `error_response_count`, `error_rate`, `availability_status` |
| Shopify Partner | `active_merchants`, `installs`, `uninstalls`, `earnings_amount` |

`scan_completion_rate` is `scan_completed_count / scan_started_count` when at
least one scan started; otherwise it is absent rather than zero. `error_rate`
uses the source's total request and error counts when both are available.

Snapshots record `partial`, `unavailable`, or `failed` rather than inventing a
zero. The summaries must display source freshness and omit comparisons that
would make an incomplete source look healthy.

## Collection and scheduling

The initial job is deterministic and idempotent:

1. For each source, request the previous completed UTC day.
2. Validate and persist that source's snapshot with its collection status.
3. Build the daily health summary only from that date's snapshots.
4. On the weekly schedule, select the last seven completed UTC days and the
   preceding seven completed UTC days, then build the review from stored data.

The daily job must not query a still-open day. It may be run manually for a
specified past date to backfill a missed snapshot, but it must retain the
original collection timestamp and mark the backfill in notes.

The weekly review is a scheduled Sunday-after-close summary by default. It is
not an LLM-authored operational decision: the deterministic layer calculates
the values and comparison deltas first. A later Buffr workflow may interpret
the normalized evidence, but cannot change the stored numbers.

## Source access boundaries

**PostHog.** The connector uses a separate, read-only PostHog query credential,
not the MerchGrid project token that ingests events. It queries only the four
approved event names and aggregate counts for a bounded date range.

**Fly Metrics.** The connector queries Fly's managed Prometheus-compatible API
using a least-privilege Fly access token scoped to the relevant organization.
Fly retains managed metrics for about 15 days, so daily snapshotting is required
for week-over-week history beyond that window. Grafana remains a visualization
surface, not the connector target.

**Shopify Partner.** The connector begins with a capability check against the
Partner API for the defined aggregate metrics. If a required metric is not
available through a stable read-only API query, Buffr imports the corresponding
Partner Dashboard CSV export into the same `shopify_partner` snapshot contract.
The summary must label it as a manual import. No screen scraping is in scope.

All credentials remain in ignored local configuration or the future secret
store. No access token, organization identifier, raw API response, merchant
identity, shop domain, catalog data, email address, or PostHog event payload is
stored in a snapshot.

## Output contracts

The **daily health summary** contains:

- date and source freshness;
- availability and error-rate status from Fly Metrics;
- scan queue outcome counts from PostHog;
- an explicit list of unavailable or partial sources.

The **weekly business review** contains:

- the seven-day period and preceding comparison period;
- installs, uninstalls, active merchants, and earnings when supplied by
  Shopify Partner data;
- app-open, scan-start, scan-completion, and scan-failure trends from PostHog;
- reliability trend from Fly Metrics;
- source coverage and limitations before any interpretation.

Neither output is a dashboard requirement. The first delivery surface is a
persisted Buffr evidence artifact that the existing workflow can read.

## Failure handling and observability

Each source is isolated. A PostHog query failure must not prevent a Fly snapshot
or a daily health artifact from being written. Source errors are reduced to a
bounded classification such as `authentication`, `rate_limit`, `transport`,
`schema`, or `unknown`; response bodies and tokens are never persisted.

The collector records structured run events for source start, completion,
partial result, and failure. Retries use bounded deterministic policy. The job
does not retry indefinitely and does not substitute a previous day's metric as
today's value.

## Testing

Tests use fake connectors and fixed clock values. They prove:

- each adapter maps a source aggregate into the shared snapshot contract;
- missing or zero-denominator metrics are represented correctly;
- one source failure leaves other source snapshots and the partial daily
  summary intact;
- duplicate collection for a successful source/date is idempotent;
- the weekly review compares exactly two complete seven-day windows;
- no raw event properties, credentials, merchant identity, or source payloads
  appear in persisted snapshots or output artifacts.

## Decisions and deferred work

- The system starts with daily aggregates rather than raw-event warehousing.
- Buffr owns collection, normalization, and review generation; MerchGrid owns
  operational work and emits safe PostHog events only.
- The first source of truth remains each provider's own dashboard/API.
- GA4 Shopify App Store listing traffic, custom Fly application metrics,
  real-time alerts, automated recommendations, and an internal dashboard are
  deferred.
- After this spec is reviewed, a separate implementation plan will identify
  the precise Buffr paths, source-auth setup, schedule host, persistence
  adapter, and staged delivery order.

## References

- [Fly Metrics documentation](https://fly.io/docs/monitoring/metrics/)
- [Shopify Partner Dashboard app analytics](https://shopify.dev/docs/apps/launch/distribution/track-app-usage)
- [Shopify Partner API overview](https://shopify.dev/docs/api)
- [PostHog API schema](https://us.posthog.com/api/schema/)
