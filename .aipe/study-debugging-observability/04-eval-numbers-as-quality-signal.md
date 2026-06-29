# Eval-Numbers-As-Quality-Signal

**Industry names:** offline retrieval eval · precision@k / recall@k ·
information-retrieval metrics. **Type:** Industry standard (IR evaluation),
applied here as the repo's only numeric quality signal.

---

## Zoom out, then zoom in

You know how a test suite gives you a green/red bit — pass or fail? Retrieval
quality isn't a bit; it's a *score*. "Did the right documents come back in the top
k?" is a number between 0 and 1, and this repo computes two of them: precision@1
and recall@3 over a labeled set of queries. That's the only place in the whole
repo where behavior is measured as a number rather than recorded as an event or
printed as a line.

Where it sits — and note it's *offline*, off to the side of the live path:

```
  Zoom out — the eval loop is off the hot path

  ┌─ Live path (chat) ────────────────────────────────────────┐
  │  chat.tsx → session.ask → agent → pipeline.query (top-k)  │
  └────────────────────────────────────────────────────────────┘
            (same retrieval pipeline, different caller)
  ┌─ Offline eval path ═══════════════════════════════════════┐
  │ ║ eval-cmd.ts → pipeline.query(query, K)                  ║│ ← we are here
  │ ║ → scorePrecisionAtK / scoreRecallAtK → print P@1 / R@3  ║│
  │ ║   over eval/queries.json (labeled set)                  ║│
  └────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **offline IR evaluation as a quality signal** — run a
fixed set of labeled queries through the *real* retrieval pipeline, score how many
relevant docs land in the top k, average it. The question it answers: *is
retrieval good enough, as a number I can compare run to run?* The catch this file
keeps honest: it's a *batch you run by hand*, not a *live SLI* — it tells you
about a snapshot of the corpus + a fixed query set, not about production traffic.

## Structure pass

Two layers, one axis: **what does this number actually measure — the system, or a
sample of it?** Tracing that axis is what separates an SLI from an offline eval.

```
  Axis — "measures live behavior or a fixed sample?" — across the seam

  ┌─ the metric (P@k, R@k) ─────┐  seam: the input set  ┌─ the inputs ───────────┐
  │ score in [0,1], per query   │ ════════╪════════════►│ eval/queries.json:     │
  │ averaged across the set     │ (fixed, hand-curated, │ {query, relevant[]}    │
  │                             │  not production)      │ labeled by a human     │
  └─────────────────────────────┘                       └────────────────────────┘
  axis answer: a SAMPLE, not live traffic → it's an offline eval, not an SLI
```

The load-bearing seam is `eval/queries.json` — the labeled set. The metric is
only as honest as that file is representative. Change the corpus or the queries
and the number moves for reasons unrelated to production behavior. That's the line
between this and a real SLI (which would sample *live* queries and have an
objective + alert — none of which exist here; see audit lens 4).

## How it works

### Move 1 — the mental model

You've scored a search before, even informally: "I searched, did the thing I
wanted show up near the top?" Precision@k and recall@k make that precise.
Precision@1: of the *top 1* doc returned, was it relevant? Recall@k: of *all* the
relevant docs, how many showed up in the top k? Run that over a labeled set,
average, and you have a quality number.

```
  The pattern — score retrieval against a labeled answer key

  for each query in the labeled set:
     hits      = pipeline.query(query, K)        ← real retrieval
     returned  = unique docIds from hits
     relevant  = the human-labeled answer set
     P@1 = (returned[0] ∈ relevant) ? 1 : 0      ← top-1 correct?
     R@K = |returned[:K] ∩ relevant| / |relevant| ← how much of the truth found?
  mean over all queries = the run's score
```

The kernel: **a labeled set + the real pipeline + a scoring function, averaged.**
Drop the labeled set and you have nothing to score against; use a *fake* pipeline
and you're measuring the mock, not the system.

### Move 2 — the step-by-step walkthrough

**The use case.** Catching retrieval regressions before they reach the chat. You
re-index, run `npm run eval`, and compare the mean P@1 / R@3 to last time. A drop
means retrieval got worse — the seam this shares with study-testing.

**Part 1 — load the labeled answer key.** The eval's honesty lives in this file.

```ts
// src/cli/eval-cmd.ts:18-21
const queries: { query: string; relevant: string[] }[] = JSON.parse(
  await readFile(new URL('../../../eval/queries.json', import.meta.url), 'utf8'));
```

Each entry is `{ query, relevant }` — a question and the doc ids a human says
*should* come back. That's the ground truth. Boundary condition: if `relevant` is
mislabeled or the set is unrepresentative, the score is precise but meaningless —
garbage-in on the answer key.

**Part 2 — run each query through the REAL pipeline.** This is what makes it an
eval and not a unit test: same `createRetrievalPipeline` the chat uses
(`src/session.ts:42`, `src/cli/eval-cmd.ts:16`), same embedder, same store.

```ts
// src/cli/eval-cmd.ts:22-31
const K = 3;
let p1 = 0, rk = 0;
for (const { query, relevant } of queries) {
  const hits = await pipeline.query(query, K);                 // ← real retrieval
  const docs = [...new Set(hits.map((h) => String(h.meta.docId)))];  // dedupe to docs
  const p = scorePrecisionAtK(docs, new Set(relevant), 1).score;
  const r = scoreRecallAtK(docs, new Set(relevant), K).score;
  p1 += p; rk += r;
  process.stdout.write(`${query.padEnd(44)} P@1 ${p.toFixed(2)}  R@${K} ${r.toFixed(2)}\n`);
}
```

Note the `[...new Set(...)]` — hits are *chunks*, but relevance is judged at the
*document* level, so chunk ids are collapsed to `docId` before scoring. That's a
real modeling decision: you're asking "did the right *document* surface," not "the
right chunk." `scorePrecisionAtK` / `scoreRecallAtK` come from aptkit
(`@rlynjb/aptkit-core`) — buffr supplies the labeled set and the pipeline; aptkit
supplies the math.

**Part 3 — average and report.** The run's headline is the mean across queries.

```ts
// src/cli/eval-cmd.ts:33
process.stdout.write(`\nmean P@1 ${(p1 / queries.length).toFixed(2)}  mean R@${K} ${(rk / queries.length).toFixed(2)}\n`);
```

```
  Layers-and-hops — labeled set in, score out, over the live pipeline

  ┌─ eval/queries.json ─┐ {query,relevant}  ┌─ pipeline.query ────┐ top-K chunks
  │  labeled answer key │ ────────────────► │ embed → ANN search  │ ──────────┐
  └─────────────────────┘                   │ (same as chat)      │           │
                                            └─────────────────────┘           ▼
  ┌─ score + mean ──────┐ ◄──── P@1 / R@K ──── dedupe chunks→docs ◄── hits ────┘
  │ stdout: per-query   │      scorePrecisionAtK / scoreRecallAtK
  │ + mean P@1 / R@3    │
  └─────────────────────┘
```

#### Move 2.5 — what this number is, and what it is NOT

This is the honest line, and it's why this file exists instead of just a footnote.

```
  Offline eval (what the repo has)   vs   Live SLI (what it doesn't)
  ──────────────────────────────────     ─────────────────────────────
  fixed labeled query set                samples real production queries
  run by hand (npm run eval)             computed continuously
  one snapshot per run                   a rate / percentile over time
  no objective, no alert                 SLO + alert threshold
  measures: retrieval on THIS set        measures: retrieval on REAL traffic
```

So: it's a strong *regression gate* (re-run, compare, catch a drop) and a weak
*production signal* (it never sees a real user's query, never trends over time,
never alerts). Calling P@1/R@3 an "SLI" would overclaim — it's an offline eval
that *could become* the basis of one if you sampled live queries and set an
objective. Audit lens 4 names that gap; this is where it's grounded.

#### Move 3 — the principle

When quality is a score, not a bit, measure it with a labeled set run through the
real system — and be precise about what the set represents. The same metric is an
honest regression gate *and* a misleading production signal depending on whether
its inputs are a fixed sample or live traffic. The number doesn't tell you which;
you have to.

## Primary diagram

The whole eval as a quality signal, with its boundary marked.

```
  Eval-numbers-as-quality-signal — offline, over the real pipeline

  ┌─ INPUTS ──────────────────────────────────────────────────────────┐
  │  eval/queries.json — [{ query, relevant: docId[] }]  (human-labeled)│
  └───────────────────────────────┬───────────────────────────────────┘
  ┌─ REAL PIPELINE (same as chat) ▼───────────────────────────────────┐
  │  pipeline.query(query, K=3) → embed → ANN (pgvector HNSW) → chunks │
  │  → dedupe to docIds                                                │
  └───────────────────────────────┬───────────────────────────────────┘
  ┌─ SCORING (aptkit) ────────────▼───────────────────────────────────┐
  │  scorePrecisionAtK(docs, relevant, 1) · scoreRecallAtK(docs, ., 3) │
  │  accumulate → mean P@1 / mean R@3 → stdout                         │
  └───────────────────────────────┬───────────────────────────────────┘
  ┌─ BOUNDARY (the honest line) ──▼───────────────────────────────────┐
  │  offline regression gate ✓   |   live production SLI ✗ (no alert,  │
  │  run by hand, fixed set      |    no trend, never sees real query) │
  └───────────────────────────────────────────────────────────────────┘
```

## Elaborate

Precision@k and recall@k are the workhorse metrics of information retrieval —
they predate RAG by decades and carry straight over to "did the right chunks feed
the LLM." The offline-eval-over-labeled-set discipline is how you keep retrieval
honest without production traffic: a golden set, the real pipeline, a score you
compare run to run. The gap between this and a production SLI is exactly the gap
between a test fixture and live telemetry — same metric, different inputs, very
different claims.

This is the sharpest seam with **study-testing**: that guide owns
`eval/queries.json` as a *regression gate* (does the score hold?); this guide owns
it as an *observability signal* (what does the score tell you about behavior?).
Same file, two lenses — cross-link, don't duplicate. The metric's raw cousins —
`durationMs`, `tokens_used` captured in the trace (file 01) — belong to
study-performance-engineering when turned into latency/cost metrics.

## Interview defense

**Q: You call P@1/R@3 a quality signal — is it an SLI?** No, and the distinction
is the answer. It's an *offline* eval: a fixed, human-labeled query set run
through the real retrieval pipeline by hand. An SLI samples *live* traffic,
trends over time, and has an objective with an alert — none of which exist here.
It's a strong regression gate and a weak production signal. Calling it an SLI
would overclaim.

```
  fixed labeled set + run by hand → regression gate (not a live SLI)
```

**Q: Why score at the document level when retrieval returns chunks?** Because
relevance is labeled per document — `eval/queries.json` lists relevant *doc ids*.
So I dedupe chunk hits to their `docId` (`[...new Set(...)]`) before scoring,
asking "did the right document surface in the top k," not "the right chunk." If I
scored per chunk against doc-level labels, the metric would be incoherent.

```
  hits (chunks) → unique docIds → score against doc-level labels
```

**Q: What makes this eval trustworthy — or not?** It runs the *same* pipeline the
chat uses (same embedder, store, ANN index), so it measures the real system, not
a mock — that's the trustworthy part. The fragile part is the labeled set: the
score is only as representative as `eval/queries.json`. Change the corpus or the
queries and the number moves for reasons unrelated to production. The honest
framing is: precise about the sample, silent about live traffic.

## See also

- `03-stdout-as-only-log.md` — the stdout transport these numbers are printed over.
- `01-full-signal-trajectory-capture.md` — `durationMs` / `tokens_used`, the
  other captured numbers (performance, not quality).
- `audit.md` lens 4 (metrics-slis-slos) — where the "not a live SLI" gap is named.
- Cross-guide: study-testing (the same `eval/queries.json` as a regression gate),
  study-performance-engineering (turning captured timing/tokens into metrics).
