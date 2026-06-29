# Eval-Numbers-as-Quality-Signal

**Industry name(s):** offline retrieval evaluation / ranking metrics as a health signal — precision@k and recall@k (`P@1`, `R@3`) — *Industry-standard* metrics, *Project-specific* use as the repo's only retrieval observability.

The repo's entire "is retrieval healthy?" instrument is one hand-run CLI that scores a labeled query set and prints the numbers. No metric is stored, no objective is set, no alert fires — but the numbers themselves are real, comparable signal. This file treats the eval output as what it actually is: the only quality observability buffr has for its core function.

---

## Zoom out, then zoom in

Here's where this sits. buffr's whole reason to exist is retrieval — pull the right chunks for a question. The only thing that tells you whether retrieval is *working* is this eval CLI.

```
  Zoom out — where the quality signal is produced

  ┌─ CLI layer (src/cli/eval-cmd.ts) ───────────────────────────┐
  │  for each labeled query → pipeline.query() → score → print  │ ← we are here
  └────────────────────────────────┬─────────────────────────────┘
            P@1 / R@3 per query     │  (printed, not stored)
  ┌─ Retrieval (createRetrievalPipeline) ──▼────────────────────┐
  │  embed query → ANN search over chunks → ranked hits          │
  └────────────────────────────────┬─────────────────────────────┘
  ┌─ Storage (agents.chunks, HNSW) ▼────────────────────────────┐
  │  the vectors whose ranking quality the eval measures         │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in. The question: *is retrieval returning the right documents, and would I notice if a change made it worse?* The pattern is **score a fixed labeled set with ranking metrics**: a frozen `eval/queries.json` maps each query to its known-relevant doc ids; `P@1` asks "was the top hit relevant?", `R@3` asks "how many of the relevant docs showed up in the top 3?". The numbers are the signal.

## The structure pass

**Layers:** the labeled query set (ground truth) → the pipeline query (the thing under test) → the scorers (the measurement) → stdout (the readout).

**Axis — "where does ground truth come from?"** Trace it:

```
  One question down the layers: who holds the ground truth?

  ┌──────────────────────────────────────────────┐
  │ eval/queries.json                             │  → HUMAN-LABELED
  │   { query, relevant: [docId, …] }             │    (the source of truth)
  └───────────────────────┬───────────────────────┘
       seam: scorePrecision/Recall  ═══ truth meets prediction ═══
  ┌───────────────────────▼───────────────────────┐
  │ pipeline.query(query, K) → docIds             │  → MODEL-PREDICTED
  │   embed + ANN search                           │    (the thing measured)
  └───────────────────────┬───────────────────────┘
       seam: process.stdout.write  ═══ signal meets the void ═══
  ┌───────────────────────▼───────────────────────┐
  │ printed P@1 / R@3                             │  → EPHEMERAL
  │   not stored, not trended, not alerted          │    (the readout dies)
  └────────────────────────────────────────────────┘
```

**Two seams.** The first — where labeled truth meets model prediction — is where the *signal is created*; that's good. The second — where the score hits stdout — is where the *signal dies*; that's the gap. The metrics are sound; the observability around them is `03-stdout-as-only-log.md` all over again.

## How it works

#### Move 1 — the mental model

You've graded a multiple-choice test against an answer key. `P@1` is "did they get the first question right?" averaged over students; `R@3` is "of the answers that should've been on their top-3 list, how many were?" The query set is the answer key, `pipeline.query()` is the student, the scorers are you with a red pen.

```
  The shape — score prediction against a frozen answer key

  eval/queries.json (the key)        pipeline.query (the student)
  ──────────────────────────         ────────────────────────────
  query: "how does sync work"        hits → docIds: [d2, d7, d1]
  relevant: { d2, d9 }                        │
                  │                            │
                  └────────► score ◄───────────┘
                       P@1 = (d2 ∈ relevant?) = 1.00   ← top hit was right
                       R@3 = |{d2} ∩ relevant| / |relevant|
                           = 1/2 = 0.50               ← caught 1 of 2 relevant

         mean across all queries → the one health number
```

The diagram is the mechanism: per query you get two numbers, you mean them across the set, and that mean is buffr's retrieval-health readout.

#### Move 2 — the step-by-step walkthrough

**Load the frozen ground truth.** The labeled set is read once (`src/cli/eval-cmd.ts:19-20`):

```
  src/cli/eval-cmd.ts:19   const queries: { query: string; relevant: string[] }[] =
  :20     JSON.parse(await readFile(new URL('../../../eval/queries.json', …), 'utf8'));
```

Each entry is a query plus the doc ids a human deemed relevant. This file *is* the source of truth — the whole eval is only as honest as these labels. The boundary condition: if `relevant` is stale (a doc was re-indexed under a new id), the scores drop for a reason that has nothing to do with retrieval quality. The ground truth has to track the corpus.

**Run the thing under test and score it.** The loop queries the pipeline at K=3, dedups to doc ids, and scores (`src/cli/eval-cmd.ts:22-30`):

```
  src/cli/eval-cmd.ts:24   for (const { query, relevant } of queries) {
  :25     const hits = await pipeline.query(query, K);
  :26     const docs = [...new Set(hits.map((h) => String(h.meta.docId)))];
  :27     const p = scorePrecisionAtK(docs, new Set(relevant), 1).score;   // P@1
  :28     const r = scoreRecallAtK(docs, new Set(relevant), K).score;       // R@3
  :29     p1 += p; rk += r;
```

Read the two metric choices. `scorePrecisionAtK(…, 1)` measures *only the top hit* — for a RAG agent that synthesizes from the first chunk, "is rank 1 relevant?" is the metric that matters most. `scoreRecallAtK(…, K)` at K=3 measures coverage — did the relevant docs make the shortlist the agent actually sees? The dedup on `docId` (`:26`) is load-bearing: multiple chunks from one doc collapse to one, so the metric is per-*document*, matching how `relevant` is labeled.

**Print and aggregate — where the signal dies.** Per-query and mean both go to stdout (`src/cli/eval-cmd.ts:31-33`):

```
  src/cli/eval-cmd.ts:31   process.stdout.write(`${query.padEnd(44)} P@1 ${p.toFixed(2)} …\n`);
  :33   process.stdout.write(`\nmean P@1 …  mean R@3 …\n`);
```

The boundary condition is the whole gap: this is the *only* place the number exists. Nothing writes the run to a table, so there's no baseline to diff against. You compare "is retrieval worse than last week" by eyeballing two terminal windows. → this is `03-stdout-as-only-log.md` applied to the one metric that matters most.

#### Move 2 variant — the load-bearing skeleton

The kernel of an offline eval, named by what breaks without each part:

1. **A frozen labeled set** — the answer key. Drop it and there's no ground truth; the scores measure nothing. (`eval/queries.json`)
2. **A deterministic run of the thing under test** — `pipeline.query()` over the same corpus. If the corpus shifts between runs, score deltas conflate "model changed" with "data changed." (`eval-cmd.ts:25`)
3. **Ranking metrics that match how the output is used** — `P@1` because the agent leans on the top hit; `R@3` because it sees the top 3. Pick the wrong k and you measure a quality the agent never experiences. (`:27-28`)
4. **An aggregate** — the mean, the single number you actually track. (`:33`)

What's *missing*, and is the observability gap: **a stored run with a timestamp**. Without it there's no trend, no regression alert, no before/after. The metrics are present and correct; the *observability* — storage, trend, threshold — is absent. That absence is exactly why this is a debugging-observability finding and not just a testing one.

#### Move 2.5 — current state vs future state

This is a built-but-thin instrument, so the Phase A / Phase B comparison earns its place.

```
  Phase A (now)                      Phase B (when unattended)
  ───────────────────────────        ──────────────────────────────
  hand-run: npm run eval             scheduled / CI run
  P@1 / R@3 → stdout                 P@1 / R@3 → stored row + timestamp
  compared by eyeball                trended; alert if mean drops > X
  one corpus snapshot                versioned corpus + label set
  no baseline                        last-good baseline to diff against

  what DOESN'T change: the metrics (P@1, R@3), the scorers, the
  labeled-set format. Phase B is pure observability plumbing around
  an already-correct measurement.
```

The takeaway: buffr already did the *hard* part (a real labeled set, the right metrics). What's deferred is the *plumbing* — storing the number and watching it move. That's a small, additive change, not a redesign.

#### Move 3 — the principle

**A metric you print is a measurement; a metric you store and trend is an instrument.** The number `mean P@1 0.82` tells you retrieval is decent *today*; only a stored series tells you a change made it worse. The general rule for quality observability: the value of an eval is in the *delta over time*, and you can't see a delta you didn't record. `study-testing` owns the eval as a correctness guard; this guide owns it as a signal you should be *trending*, not eyeballing.

## Primary diagram

```
  Eval as quality signal — the full path, and where it stops

  GROUND TRUTH                    UNDER TEST                MEASURE
  ────────────                    ──────────                ───────
  eval/queries.json   ──────────► pipeline.query(q, 3)  ──► dedup docIds
   {query, relevant}              (embed + HNSW ANN)            │
        │                                                       ▼
        └──────────────────────────────────────────► scorePrecisionAtK(…,1) → P@1
                                                       scoreRecallAtK(…,3)   → R@3
                                                              │
                                                       sum / mean
                                                              │
                                                              ▼
                                       process.stdout.write(P@1 / R@3)
                                                              │
                                              ✗ STOPS HERE — not stored,
                                                not trended, not alerted
```

## Elaborate

These metrics come from information retrieval, decades older than RAG. `P@k` and `R@k` are the canonical way to score a ranked result list against relevance judgments — the same math behind search-engine quality scoring. buffr applies them to the RAG retrieval step, which is exactly right: RAG *is* retrieval-then-generate, and the retrieval half is a ranking problem with a measurable answer key.

The choice of `P@1` specifically is worth defending: for a generation agent that grounds its answer in the retrieved chunks, the rank-1 hit disproportionately shapes the output, so "is the top hit relevant" is the highest-signal single number. `R@3` complements it — precision alone could hide that you're missing half the relevant docs. The pair is a deliberate, sound choice (`eval-cmd.ts:27-28`).

Where it connects: `study-testing` treats this CLI as a regression guard (does a change drop the score below a bar). This guide treats the same numbers as a *signal to observe over time*. The seam between the two guides is `eval/queries.json` — testing owns the labels' correctness; observability owns whether anyone's watching the trend.

## Interview defense

**Q: How do you know your retrieval is good, and would you catch a regression?**

```
  P@1 answers "good"; the missing trend answers "regression"

  npm run eval ──► mean P@1 0.82  ← good TODAY (a measurement)
                          │
                   not stored ──► no series ──► no regression seen
                          │
                   FIX: store {ts, meanP1, meanR3} → diff vs last-good
```

Today, by hand: `npm run eval` scores a labeled set and prints `P@1` / `R@3` (`eval-cmd.ts:27-33`). `P@1` is the right headline because the agent leans on the top hit. Would I catch a regression? Not reliably — the number isn't stored, so there's no baseline to diff (`:31`). The fix is small and additive: persist each run with a timestamp and alert on a drop. **Anchor:** the print-and-forget at `eval-cmd.ts:33` — a measurement, not yet an instrument.

**Q: Why `P@1` and not `P@3`?**

Because the agent's answer is grounded most in the rank-1 chunk, so the top hit's relevance is the highest-signal number; `R@3` covers whether the relevant set made the shortlist the agent actually sees. Matching the metric's k to how the output is consumed is the load-bearing call. **Anchor:** `scorePrecisionAtK(docs, …, 1)` vs `scoreRecallAtK(docs, …, K)` at `eval-cmd.ts:27-28`.

## See also

- `03-stdout-as-only-log.md` — the print-and-forget surface this metric shares.
- `audit.md` lens 2 (controlled experiment), lens 4 (the SLI that isn't), lens 7 (regression guard).
- Cross-guide: `study-testing` (the eval as a correctness/regression guard), `study-performance-engineering` (retrieval latency as the other half of "healthy retrieval").
