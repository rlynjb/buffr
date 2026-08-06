# 04 — Scatter-gather across concurrent external connectors

## Subtitle

**Scatter-gather** (aka fan-out/fan-in) with **per-branch failure
classification** — *Industry standard* pattern, newly exercised in this repo.
In buffr this is the `Collector` capability
(`packages/capabilities/src/collector/index.ts:25-63`), driving `/research`
and `/investing`.

## Zoom out, then zoom in

Every earlier file in this guide describes buffr talking to *one* remote at a
time. `/research` and `/investing` don't: each turn now queries up to five
independent external services — Google Trends, Brave Search, Tavily, Google
Custom Search, Reddit — **concurrently**, then gathers whatever came back.
This is the first place in the repo where more than one remote is in flight
at once, and it's the first place a genuine "what if one of N independent
things fails and the others don't" question shows up.

```
  Zoom out — where the fan-out lives

  ┌─ Client (one Node process) ─────────────────────────────────────┐
  │  research-flow.ts / session.ts researchCollect()                 │
  │        │                                                          │
  │        ▼                                                          │
  │  MarketResearchEngine.collect()  (engine.ts:56-117)               │
  │        │  Promise.all over sources                                │
  │        ▼                                                          │
  │  ★ Collector.execute()  (collector/index.ts:29-62) ★  ← we are here │
  └───┬───────────┬───────────┬───────────┬───────────┬──────────────┘
      │ HTTPS      │ HTTPS      │ HTTPS      │ HTTPS      │ HTTPS
      ▼            ▼            ▼            ▼            ▼
  ┌─ Provider ┐┌─ Provider ┐┌─ Provider ┐┌─ Provider ┐┌─ Provider ┐
  │ Google    ││ Brave     ││ Tavily    ││ Google    ││ Reddit    │
  │ Trends    ││ Search    ││ Search    ││ Custom    ││ .json     │
  │           ││           ││           ││ Search    ││           │
  └───────────┘└───────────┘└───────────┘└───────────┘└───────────┘

  five independent remotes, in flight at the same time, none aware of
  the others — the coordination question this file answers.
```

Zoom in: the pattern is **scatter-gather** — scatter the same logical request
across N independent branches, run them concurrently, gather whatever
succeeds without letting one failure sink the rest. The distributed-systems
question it answers: *when five remotes are in flight and any subset of them
can fail, time out, or return nothing, what does the caller actually get
back?*

## Structure pass — layers, one axis, the seam

Trace **one axis — failure containment — across the fan-out** and watch where
it's caught versus where it isn't.

```
  axis traced = "where does one source's failure get contained?"

  ┌─ engine: MarketResearchEngine.collect() ──┐   → NOT the containment
  │  Promise.all(sources.map(...))            │     point — it just waits
  └───────────────────┬────────────────────────┘     on N branches
                      │  seam — per-source try/catch
  ┌─ Collector.execute() (index.ts:38-50) ────┐   → CONTAINED here:
  │  try { fetch } catch { push to failed[] } │     one throw never reaches
  └───────────────────┬────────────────────────┘     the outer Promise.all
                      │  HTTPS, no signal/timeout
  ┌─ connector.fetch() → external API ────────┐   → NOT bounded: no
  │  Brave / Tavily / Google / Reddit / Trends│     deadline on the call
  └─────────────────────────────────────────────┘

  the axis flips exactly once — inside Collector.execute's try/catch.
  everything above that seam is safe from a single source's failure;
  nothing below it is safe from a single source's SLOWNESS.
```

The **seam is the per-source `try { … } catch { … }`** inside
`Collector.execute` (`index.ts:38-50`). That's the boundary that turns "any
one of five HTTP calls can throw" into "the gather always completes." It's
also the only seam in this file — there's no second seam bounding *how long*
a branch is allowed to take.

## How it works

### Move 1 — the mental model

You've written `Promise.allSettled` — fire N `fetch()` calls, don't let one
rejection sink the batch, then look at `status: 'fulfilled' | 'rejected'` on
each result to decide what to do with the batch. `Collector.execute` is that
same shape, hand-rolled: it uses `Promise.all` over an array of `async`
functions that each catch their own error internally, so from the outside
every branch always "fulfills" — the failure is captured as data
(`failed.push(...)`) instead of as a rejection. The one thing
`Promise.allSettled` gives you for free that this hand-rolled version
doesn't: a per-branch timeout. `Promise.allSettled` still waits for every
promise to settle, however long that takes — and neither the built-in nor
buffr's version bounds that here.

```
  the scatter-gather kernel — fan out, isolate, classify, gather

   sources = [trends, brave, tavily, google, reddit]
        │
        ▼  scatter (Promise.all)
   ┌─────────┬─────────┬─────────┬─────────┬─────────┐
   │ trends  │ brave   │ tavily  │ google  │ reddit  │   ← concurrent
   └────┬────┴────┬────┴────┬────┴────┬────┴────┬────┘
        │ ok       │ 429 err  │ ok       │ ok       │ timeout (unbounded)
        ▼          ▼          ▼          ▼          ▼
   evidence[]  failed[]   evidence[]  evidence[]  (still waiting…)
        │          │          │          │          │
        └──────────┴─────┬────┴──────────┴──────────┘
                          ▼  gather (all branches settled)
              { evidence, failed, warnings }
```

Name the parts by what breaks without them:

- **The fan-out (`Promise.all(sources.map(...))`, `index.ts:35`)** — without
  it, sources run one after another; a slow Brave call delays Tavily's
  request from even starting. This is the thing that makes five external
  calls cost roughly as much wall-clock time as the slowest one, not the sum
  of all five.
- **The per-source `try/catch` (`index.ts:38-50`)** — without it, one
  connector's thrown error rejects the outer `Promise.all` immediately and
  the *other four* results — already in flight, possibly already
  succeeded — are discarded. This is the load-bearing part: it's what turns
  "any failure kills the turn" into "any failure degrades the turn."
- **The `optional` classification (`index.ts:47-49`)** — without it, there's
  no way to distinguish "a nice-to-have enrichment source came back empty"
  from "a source the answer depends on just failed." Every failure would
  either always warn or never warn.
- **The aggregation (`evidence[]`, `failed[]`, `warnings[]`, returned at
  `index.ts:54-61`)** — without it, a partial failure would be invisible to
  the caller; there'd be nothing to show the user which sources came back
  and which didn't.

### Move 2 — the walkthrough

**The fan-out and the seam, in one function.** This is the entire mechanism
(`packages/capabilities/src/collector/index.ts:29-62`):

```ts
async execute(input: CollectorInput, context: AgentContext): Promise<AgentResult<CollectorOutput>> {
  const evidence: Evidence[] = [];
  const failed: Array<{ sourceId: string; reason: string }> = [];
  const warnings: string[] = [];

  await Promise.all(
    input.sources.map(async (source) => {                    // ← scatter
      try {
        const result = await source.connector.fetch(source.params);  // ← no signal/timeout
        evidence.push(...result.toEvidence());
      } catch (err) {                                          // ← the seam
        const reason = err instanceof Error ? err.message : String(err);
        failed.push({ sourceId: source.connector.id, reason });
        if (!(source.optional ?? false)) {                     // ← classification
          warnings.push(`Required source '${source.connector.id}' failed: ${reason}`);
        }
      }
    }),
  );

  return { data: { evidence, failed }, warnings, /* … */ };    // ← gather
}
```

The `catch` block never re-throws. That's the whole trick: as far as the
outer `Promise.all` is concerned, every mapped promise resolves — the
distinction between "succeeded" and "failed" moved from the promise's
settlement state into the `evidence`/`failed` arrays, which is exactly what
`Promise.allSettled` would hand you natively, just built by hand here.

**Two engines drive it, two different shapes, same seam.** `InvestingEngine`
calls `Collector.execute` once with all sources in one array
(`packages/engines/investing/src/engine.ts:45`) — one scatter-gather, one
`failed[]` for the whole batch. `MarketResearchEngine.collect()`
(`packages/engines/market-research/src/engine.ts:76-98`) calls
`Collector.execute` **once per source**, each wrapped in its *own* outer
`Promise.all` at the engine level — functionally the same concurrency, just
restructured so each source can emit its own `connector-start` /
`connector-done` / `connector-failed` progress event for the chat UI's live
panel. Either shape passes through the same seam.

**Every source in this repo is `optional: true`.** Both engines' source
lists are built in `src/session.ts`:

```ts
// src/session.ts:520-559 — every MarketResearchSource entry:
{ connector: new CachedConnector(new GoogleTrendsConnector(), ...), optional: true },
...(braveConnector  ? [{ connector: braveConnector,  optional: true }] : []),
...(tavilyConnector ? [{ connector: tavilyConnector, optional: true }] : []),
...(googleConnector ? [{ connector: googleConnector, optional: true }] : []),
{ connector: redditConnector, optional: true },
```

Ten `CollectorSource` entries across both engines (`session.ts:472-559`), ten
`optional: true`. That means `index.ts:47`'s `if (!(source.optional ?? false))`
branch — the one that pushes a `warnings` entry for a *required* source
failing — is currently unreachable in this codebase. Not a bug: nothing here
is load-bearing enough to be "required" yet (every source is
enrichment-grade web search), but it's worth naming plainly rather than
leaving it looking like dead code nobody noticed.

**Full-failure degrades gracefully — one layer up, not inside the
scatter-gather.** `Collector.execute` never distinguishes "0 of 5 sources
worked" from "3 of 5 worked" — it just returns whatever `evidence` array it
ended up with, empty or not. The graceful path lives in the caller
(`src/cli/research-flow.ts:85-88`):

```ts
if (collected.digest.totalCount === 0) {
  step = 'done';
  return { messages: [`No evidence found for "${topic}". Try a different topic.`], step };
}
```

If all five sources fail or all return zero results, `totalCount` is `0`,
and the flow ends with a clean message instead of handing an empty evidence
array to `Analyzer`/`Scorer`/`Teacher` (which the `evaluate()` docstring
notes assumes `evidence.length > 0`). The scatter-gather isolates *individual*
branch failures; this check is what handles the *all-branches-failed* case.

```
  Layers-and-hops — one /research turn's fan-out

  ┌─ Client ────────────────────┐         ┌─ Providers (×5, concurrent) ─┐
  │ collect()                   │ hop 1:  │ Trends │ Brave │ Tavily │... │
  │  Promise.all(sources) ──────┼────────►│   ok   │  429  │   ok   │... │
  │                              │ hop 2:  │  (each try/catch'd inside   │
  │  evidence=[...], failed=[1] │◄────────┤   Collector.execute)        │
  │                              │         └───────────────────────────┘
  │  digest.totalCount > 0?     │
  │    yes → prediction prompt  │
  │    no  → "No evidence found"│
  └──────────────────────────────┘
```

### Move 3 — the principle

**Isolating a failure and classifying it are two different jobs — do both,
or the isolation just becomes silent data loss.** `Collector`'s `try/catch`
does the isolation (a slow Reddit response can't kill the Brave result that
already came back). The `optional` flag does the classification (which
failures deserve a warning, which are fine to swallow). Skip the second job
and every failure looks the same to the caller — you can't tell "the user's
answer is now wrong" from "one enrichment source among five was a little
thin today." The gap this pattern *doesn't* close yet: isolation in space
(one source's throw can't touch another) without isolation in **time** — no
`AbortSignal`, no per-source deadline is passed into `connector.fetch()`
(`index.ts:39`), so a hung external service doesn't fail fast, it just sits
inside the `Promise.all` until the underlying `fetch()` eventually gives up
on its own. That's the same "no deadline on a wait that crosses a boundary
you don't control" lesson as `01-app-to-postgres-boundary.md`, now applied to
five boundaries instead of one.

## Primary diagram

The complete scatter-gather, seam and all, with the one thing still missing
marked.

```
  Scatter-gather across concurrent connectors — the complete picture

  ┌─ Client: one Node process ────────────────────────────────────────┐
  │                                                                    │
  │  MarketResearchEngine.collect() / InvestingEngine.execute()       │
  │       │  Promise.all(sources.map(...))                             │
  │       ▼                                                            │
  │  ┌─────────────────── Collector.execute() ─────────────────────┐  │
  │  │  for each source (CONCURRENT):                               │  │
  │  │    try { evidence.push(...connector.fetch()) }  ⚠ no deadline│  │
  │  │    catch { failed.push(...); warn IF !optional }  ← SEAM     │  │
  │  └────────┬──────────┬──────────┬──────────┬──────────┬────────┘  │
  │           │           │           │           │           │        │
  │   evidence=[…] failed=[…] warnings=[…]  (every source optional:    │
  │           │                              true — the "required"     │
  │           ▼                              warning path is dead)     │
  │   digest.totalCount === 0 ?  → "No evidence found" (research-flow) │
  └──────────┼──────────┼──────────┼──────────┼──────────┼────────────┘
             ▼          ▼          ▼          ▼          ▼
        Trends       Brave      Tavily      Google      Reddit
```

## Elaborate

Scatter-gather is the same shape behind an API gateway that fans a request
out to several backend services and assembles one response, or a
metasearch engine querying multiple indices at once — anywhere a caller
needs "the union of what N independent, unreliable things can tell me,
right now." The built-in JS primitive that expresses exactly this,
`Promise.allSettled`, would let `Collector.execute` drop its manual
try/catch bookkeeping in favor of inspecting `.status` on each settled
result — a legitimate simplification worth naming, not a correctness gap.
The missing per-source deadline is the real gap, and it's the same shape as
`01`'s missing pool timeout: not forgotten, just not yet load-bearing enough
to have forced the issue (five HTTP calls that hang all resolve or error out
via Node's own `fetch` behavior eventually; nothing internal to buffr bounds
them). The HTTP-level mechanics of each individual connector call — retries,
backoff, status-code handling — belong to `study-networking`; this file
only covers what happens when five of those calls are in flight at once and
some subset of them fail.

## Interview defense

**Q: You're calling five external search APIs concurrently. What happens
when one of them is slow?**

Verdict first: nothing bounds it today — the whole gather waits for the
slowest branch, because no timeout or `AbortSignal` is passed into any
`connector.fetch()` call.

```
  Promise.all([trends, brave, tavily, google, reddit])
       fastest source: 200ms
       slowest source: HANGS  ← Promise.all waits for it anyway
       gather completes only once ALL five settle
```

The load-bearing part people miss: the per-source `try/catch` isolates
*failures*, not *slowness* — a connector that never resolves or rejects just
sits there, and `Promise.all` sits with it. The fix, when this becomes
load-bearing, is a per-source `AbortSignal` with a timeout wired into
`connector.fetch(params, { signal })` — the `FetchOptions` type already
supports it (`packages/connectors/src/contracts.ts`), it's just not passed
today. Anchor: `packages/capabilities/src/collector/index.ts:39`.

**Q: What happens if all five sources fail?**

`Collector.execute` returns an empty `evidence` array — it doesn't
special-case "all failed" versus "some failed," it just reports what it has.
The caller does: `research-flow.ts:85` checks
`collected.digest.totalCount === 0` and ends the flow with "No evidence
found" instead of handing zero evidence to the scoring pipeline, which
assumes at least one result. That's the actual full-failure handling, and
it lives one layer above the scatter-gather, not inside it — a deliberate
split between "isolate per-branch" (Collector) and "handle the empty-set
case" (the flow that consumes it).

## See also

- `00-overview.md` — updated ranked findings.
- `audit.md` — lens 1 (map, corrected), lens 2 (partial failure, the
  `optional` classification), lens 9 (red flags, the missing per-source
  deadline).
- `01-app-to-postgres-boundary.md` — the same "no deadline on an
  out-of-process wait" shape, one boundary instead of five.
- `study-networking` — the HTTP-level mechanics (retries, backoff, status
  codes) of each individual connector call.
- `study-system-design` — how `Collector`/`Analyzer`/`Scorer`/`Teacher`
  compose into the two engines.
