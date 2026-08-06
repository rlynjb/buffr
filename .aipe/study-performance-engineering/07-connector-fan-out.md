# Connector Fan-Out — scatter-gather over independent data sources

**Industry name(s):** scatter-gather; fan-out/fan-in; concurrent request batching. **Type:** Industry standard.

`/research` and `/investing` each pull evidence from several independent external sources — Google Search, Reddit, RSS, Google Trends, Brave, Tavily. The question this file answers: does gathering them cost the *sum* of their latencies or the *max*? The answer is the max, and it's earned by one `Promise.all`, not by accident.

## Zoom out, then zoom in

Before either engine can analyze anything, it needs evidence, and evidence comes from N connectors that don't depend on each other — Reddit doesn't need to wait for Google Trends. That independence is exactly the shape scatter-gather exists for.

```
  Zoom out — where fan-out lives

  ┌─ Engine layer ─────────────────────────────────────────────────┐
  │  MarketResearchEngine.collect()   InvestingEngine.run()          │
  └───────────────────────────┬────────────────────────────────────┘
                              │  collectorSources: N independent (connector, params)
  ┌─ Capability layer ───────▼────────────────────────────────────┐
  │  Collector.execute()                                            │
  │     ★ Promise.all(sources.map(fetch)) ★                         │ ← we are here
  └───────────────────────────┬────────────────────────────────────┘
              ┌───────┬────────┼────────┬────────┐
  ┌─ Providers ▼───────▼────────▼────────▼────────▼───────────────┐
  │  Google Search · Reddit · RSS · Google Trends · Brave/Tavily    │
  │  (independent HTTP calls, no ordering dependency)                │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **scatter-gather** — scatter one request to N independent providers, gather every response, proceed only once all (or all-that-succeed) are back. buffr's `Collector` capability (`packages/capabilities/src/collector/index.ts`) is the gather point for both domain engines it owns.

## The structure pass

Axis: **cost** — wall-clock time to gather evidence from N sources.

```
  axis = "wall-clock cost of N independent connector calls"

  ┌─ if sequential (NOT what buffr does) ───────────────────────┐
  │  for source in sources: await fetch(source)                  │
  │  cost = latency(1) + latency(2) + ... + latency(N)            │   Σ — adds up
  └─────────────────────────────────────────────────────────────┘
              ═══ buffr flips this ═══
  ┌─ scatter-gather (what buffr does) ───────────────────────────┐
  │  await Promise.all(sources.map(fetch))                       │
  │  cost = max(latency(1), latency(2), ..., latency(N))          │   max — bounded by
  └─────────────────────────────────────────────────────────────┘   the slowest one
```

**Seam:** the boundary is `Collector.execute`'s `await Promise.all(...)` (`packages/capabilities/src/collector/index.ts:35-49`). On the caller's side of that line, every engine sees one `await` and gets back all evidence. On the provider side, N HTTP calls are genuinely in flight at once. That's the load-bearing boundary — cross it and cost flips from additive to bounded-by-max.

## How it works

### Move 1 — the mental model

You know how `Promise.all([fetch(a), fetch(b), fetch(c)])` runs three `fetch` calls concurrently instead of `await`ing each one in turn? That's the whole mechanism. There's no thread pool, no worker queue — JavaScript's single-threaded event loop just has three outstanding I/O operations at once, and `Promise.all` resolves when the last one lands.

```
  scatter-gather — the kernel

  scatter:  source1 ──┐
            source2 ──┼── all fired without waiting on each other
            source3 ──┘
                       │
  gather:   Promise.all(...) ── waits for ALL to settle
                       │
                       ▼
              combined evidence[]
```

### Move 2 — the load-bearing skeleton

The kernel is `Collector.execute` (`packages/capabilities/src/collector/index.ts:29-51`):

```ts
async execute(input: CollectorInput, context: AgentContext): Promise<AgentResult<CollectorOutput>> {
  const evidence: Evidence[] = [];
  const failed: Array<{ sourceId: string; reason: string }> = [];

  await Promise.all(                                    // ★ the fan-out
    input.sources.map(async (source) => {
      try {
        const result = await source.connector.fetch(source.params);
        evidence.push(...result.toEvidence());
      } catch (err) {
        failed.push({ sourceId: source.connector.id, reason: String(err) });
        if (!(source.optional ?? false)) {
          warnings.push(`Required source '${source.connector.id}' failed: ...`);
        }
      }
    }),
  );
  return { data: { evidence, failed }, ... };
}
```

Named by what breaks if removed:

- **`Promise.all` over `.map(async ...)`** — this is the entire pattern. Replace it with a `for...of` loop with `await` inside and every connector call blocks the next; N sources become N sequential round-trips. This is the one line doing all the work.
- **the per-source `try/catch` inside the mapped function** — without it, one connector throwing would reject the whole `Promise.all` (fail-fast semantics) and every *other* connector's already-in-flight result would be discarded. Catching inside the map turns "any failure kills the batch" into "each source succeeds or fails independently," which is what lets `optional: true` sources (Brave, Tavily, Google — all gated on API keys the user might not have set) fail without taking down the ones that didn't.
- **`failed` + `optional`** — the accounting that lets a caller distinguish "this optional source had no API key configured" from "a required source is down." Not a performance mechanism, but the reason the concurrency is safe to rely on: a slow or broken connector degrades the evidence set, it doesn't hang the whole gather.

**Optional hardening, not skeleton:** there's no per-source timeout and no `Promise.allSettled`-with-race pattern — `Promise.all` here waits for every source's own `fetch` to either resolve or reject, and each connector's `fetch` implementation is responsible for its own timeout (or isn't). That means the *slowest* connector, not a fixed ceiling, sets the batch's wall-clock time. See the red flag in `audit.md` lens 3.

### Move 2 variant — two engines, two call shapes, same underlying fan-out

`InvestingEngine.run()` (`packages/engines/investing/src/engine.ts:45`) makes **one** call to `collector.execute({ sources: collectorSources }, context)` with all of its sources (Brave/Tavily/Google if configured, Reddit, RSS — 2 to 5 sources) — the fan-out happens entirely inside that single call.

`MarketResearchEngine.collect()` (`packages/engines/market-research/src/engine.ts:76-98`) does something subtly different: it wraps `Promise.all` **again** at the engine level, calling `collector.execute` **once per source**, each with a single-item `sources` array:

```ts
await Promise.all(collectorSources.map(async (source) => {
  const result = await this.collector.execute({ sources: [source], onEvent: ... }, context);
  // group result.data into digestSources, keyed by connector label
}));
```

The doc comment at `engine.ts:50-55` names why: it wants a per-source digest grouped by connector name for the live progress panel (see `see also` below), and the only way to know *which* connector produced *which* evidence is to give each one its own `Collector.execute` call. The inner `Promise.all` inside each of those single-source calls is now trivial (one item), but the **outer** `Promise.all` across sources is what actually parallelizes — so the net concurrency is identical to the investing engine's single-call shape. This is the self-similar case the structure pass calls out: the same fan-out mechanism, nested one level deeper, for a UI reason (per-source labeling) rather than a performance reason.

```
  layers-and-hops — two call shapes, same wall-clock bound

  ┌─ InvestingEngine.run() ────────────────────────────────────────┐
  │  ONE collector.execute({ sources: [A,B,C,D] })                 │
  │     └─ internal Promise.all(A,B,C,D)     ← fan-out happens here│
  └───────────────────────────┬─────────────────────────────────────┘
  ┌─ MarketResearchEngine.collect() ──────────────────────────────┐
  │  outer Promise.all([                                            │
  │    collector.execute({ sources: [A] }),  ← per-source, for the  │
  │    collector.execute({ sources: [B] }),     progress-panel label │
  │    collector.execute({ sources: [C] }),                          │
  │    collector.execute({ sources: [D] }),                          │
  │  ])                                        ← fan-out happens HERE│
  └───────────────────────────┬─────────────────────────────────────┘
                              │  both bounded by max(latency), not Σ
  ┌─ Providers ────────────────▼─────────────────────────────────┐
  │  Google Search · Reddit · RSS · Google Trends · Brave/Tavily   │
  └──────────────────────────────────────────────────────────────┘
```

**Does it matter?** Yes, and it's the clearest positive latency finding in this guide. `/research` fires Google Trends (always) plus Reddit (always) plus up to three optional key-gated sources — 3 to 5 outbound HTTP calls to independent third-party APIs, each carrying real network latency (roughly 200ms-1s+ depending on provider, per the audit's networking-tier estimate). Sequential, that's additive: a 5-source turn could plausibly take several seconds before analysis even starts. Concurrent, it's bounded by whichever single source is slowest. This is a genuine wall-clock win on the one part of the pipeline that isn't `gemma2:9b` generation — `not yet measured` as an actual before/after number (no baseline exists, per audit lens 2), but the code shape guarantees the structural ceiling regardless.

### Move 3 — the principle

When N units of work don't depend on each other, the question isn't "how do I make each one faster" — it's "why am I waiting for them one at a time." `Promise.all` over independent async work is the cheapest concurrency win available in Node: no thread pool, no queue infrastructure, just not blocking on I/O you don't need to block on. The general lesson: before optimizing an individual step's latency, check whether the steps around it are already forced to be sequential when they don't need to be. buffr got this right on the first pass, in two engines, with one shared capability doing the fan-out for both — the kind of reuse that comes from putting the concurrency in the capability layer instead of duplicating it per engine.

## Primary diagram

```
  Connector fan-out — one /research turn, full path

  ┌─ MarketResearchEngine.collect() ─────────────────────────────┐
  │  4 collectorSources: Google Trends · Reddit · [Brave] · [Google]│
  └───────────────────────────┬───────────────────────────────────┘
                              │  outer Promise.all — one call per source
  ┌─ Collector.execute() × N ▼───────────────────────────────────┐
  │  each: inner Promise.all([one source])  → fetch → toEvidence() │
  └───────────────┬─────────┬─────────┬─────────┬───────────────┘
        ┌─────────▼──┐┌─────▼─────┐┌──▼──────┐┌─▼──────────┐
        │Google Trends││  Reddit   ││  Brave  ││   Google    │  ← all in flight
        │(HTML scrape)││  (API)    ││  (API)  ││   (API)     │     at once
        └─────────┬──┘└─────┬─────┘└──┬──────┘└─┬──────────┘
                   └─────────┴─────────┴──────────┘
                              │  gather: wall-clock = max(latency), not Σ
                              ▼
                   evidence[] → Analyzer → Scorer → Teacher
```

## Elaborate

Scatter-gather is one of the oldest concurrency patterns precisely because "fetch from N independent sources" is one of the most common shapes in distributed systems — search engines federating queries across shards is the classic example. The `Promise.all`-over-async-map idiom is JavaScript's version of it: no explicit thread management, because the concurrency is I/O-bound and the event loop already multiplexes it for free. The place this pattern gets dangerous is when N grows large or unbounded — a `Promise.all` with no concurrency cap and no per-item timeout means one slow or hung source can stall the whole gather, and a runaway N (say, fanning out per-subreddit instead of per-connector) could exhaust file descriptors or rate limits. buffr's N is small (2-5, config-bounded by which API keys are set) and each connector already applies its own network client's defaults, so this isn't a live risk yet — see the red flag note in `audit.md` lens 3.

For the transport-level mechanics under each connector's HTTP call — DNS, TLS, keep-alive, timeout configuration — see **`study-networking`**. For the retry/backoff and partial-failure handling (the `optional`/`failed` accounting), see **`study-distributed-systems`** if that guide covers partial-failure tolerance, or **`study-debugging-observability`** for how a failed-but-optional source surfaces in the UI. This file owns the *concurrency-shape* read: why fan-out beats sequential, and where the two engines diverge in call shape without diverging in cost.

## Interview defense

**Q: When `/research` gathers evidence from Reddit, Google, RSS, and Trends — is that sequential or concurrent?**

> Concurrent. `Collector.execute` wraps every source's `fetch` in `Promise.all(sources.map(fetch))`, so all the outbound HTTP calls are in flight at once. Wall-clock cost is bounded by the slowest single connector, not the sum of all of them. Both `InvestingEngine` and `MarketResearchEngine` route through the same `Collector` capability, so the concurrency lives in one place and both engines get it for free.

```
  sequential: Σ(latency)     — N sources, cost adds up
  scatter-gather: max(latency) — N sources, cost bounded by slowest
  buffr uses scatter-gather via Promise.all in Collector.execute
```

**Q: Market research calls `Collector.execute` once per source instead of once with all sources — isn't that a regression?**

> No — it's the same concurrency, restructured for a UI reason. The engine wraps its own `Promise.all` around N single-source `Collector.execute` calls so it can group results by connector for a live per-source progress display. The inner `Promise.all` inside each call is trivial with one item, but the outer one is where the real fan-out happens, and it's still bounded by max-latency, not sum. I'd only worry about this if N grew large enough that spinning up N separate `AgentResult` wrappers started to matter — it doesn't at 3-5 sources.

> Anchor: `packages/capabilities/src/collector/index.ts:35-49` (the fan-out), `packages/engines/investing/src/engine.ts:45` (single-call shape), `packages/engines/market-research/src/engine.ts:76-98` (per-source-call shape, same bound).

## See also

- `00-overview.md` — the connector tier in the system frame
- `audit.md` — lens 3 (latency composition), lens 5 (I/O), lens 8 (red flags)
- `08-connector-result-caching.md` — the TTL cache each connector is wrapped in before it ever reaches this fan-out
- `04-connection-pool-reuse.md` — the other place buffr amortizes a per-call cost by not doing things one at a time
- **`study-networking`** — the HTTP round-trip under each connector's `fetch`
- **`study-system-design`** — the Collector/Analyzer/Scorer/Teacher capability pipeline these connectors feed
