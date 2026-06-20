# Eval numbers as the quality signal

**Industry names:** retrieval eval / precision@k / recall@k / the offline eval
harness. **Type:** Industry standard (offline IR metrics), applied to one repo.

## Zoom out, then zoom in

You know how a test suite gives you a green/red signal that the code does what you
think? buffr has one number-shaped signal of the same kind, but for *retrieval
quality*: replay a fixed set of labeled queries through the vector store and print
how often the right document came back. That P@1 / R@3 pair is the only quantitative
quality signal in the whole system — and the thing worth being precise about is what
it does *not* measure.

```
  Zoom out — where the quality signal lives

  ┌─ CLI layer (src/cli/eval-cmd.ts) ────────────────────────────┐
  │  ★ scorePrecisionAtK / scoreRecallAtK ★  → stdout            │ ← we are here
  └───────────────────────────┬──────────────────────────────────┘
                              │ pipeline.query() ONLY
  ┌─ Retrieval (aptkit pipeline + PgVectorStore) ▼───────────────┐
  │  embed query → ANN search → ranked chunk hits                │
  └───────────────────────────┬──────────────────────────────────┘
                              │  (the agent + model are NOT in this path)
  ┌─ Agent / answer ──────────▼──────────────────────────────────┐
  │  NEVER EXERCISED by eval — no answer is scored               │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **offline retrieval evaluation against a labeled set** —
ground-truth `relevant` doc ids per query, scored with precision@1 and recall@k.
It's a real, deterministic regression signal. Its boundary is sharp: it scores the
*retriever*, never the *RAG answer*.

## Structure pass

**Layers.** Two, and the eval only touches one: the *retrieval* layer (embed +
search, which eval exercises) and the *generation* layer (agent + model, which eval
skips entirely).

**Axis — trace `what does the score measure?` across the two layers.**

```
  "what does the eval score measure?" — across layers

  ┌──────────────────────────────────────┐
  │ retrieval: embed → ANN → chunk hits  │   → MEASURED (P@1 / R@3)
  └──────────────────────────────────────┘
  ┌──────────────────────────────────────┐
  │ generation: agent → model → answer   │   → UNMEASURED (eval never runs it)
  └──────────────────────────────────────┘

  the signal covers exactly the retrieval half. the answer half is dark.
```

**Seam.** The boundary is retrieval-output vs final-answer. The eval sits entirely on
the retrieval side of it. A run can score a perfect P@1 (the right doc retrieved
first) and the agent can still produce a wrong answer (model ignores the chunk,
hallucinates, mis-cites) — and the eval will never see it, because it stops at
`pipeline.query` and never calls `agent.answer`. Knowing which side of this seam the
number lives on is the whole point of the file.

## How it works

### Move 1 — the mental model

The shape is a **labeled-replay scorer**: a fixed query→answer key, run each query,
compare what came back to the key, average the scores.

```
  the labeled-replay loop

  for each { query, relevant } in queries.json:
        hits = retrieve(query, k=3)
        docs = unique docIds from hits
        p = precision@1(docs, relevant)   ← was the TOP doc relevant?
        r = recall@3(docs, relevant)      ← how many relevant docs in the top 3?
        accumulate p, r
  print mean p, mean r
```

The kernel: ground-truth labels + a deterministic retriever + a scoring function.
What breaks without the labels: you have nothing to compare against, so "good
retrieval" becomes a vibe instead of a number.

### Move 2 — the walkthrough

**The labeled set is the ground truth.** `eval/queries.json` is a list of
`{ query, relevant: string[] }` — each query paired with the doc ids that *should*
come back. This is the answer key. Its quality caps the eval's quality: a thin or
mislabeled set gives a confident-but-meaningless score. Boundary condition: the labels
are doc ids, so the eval scores *document* retrieval, and the dedup step
(`[...new Set(docs)]`) collapses multiple chunks of the same doc into one hit — a doc
counts once no matter how many of its chunks ranked.

**P@1 — did the top result earn its spot.** Precision@1 asks one question: was the
single highest-ranked doc in the relevant set? It's binary per query (1.0 or 0.0) and
averaged across the set.

```
  precision@1 — execution trace, one query

  query:    "how do I reset my password"
  relevant: { doc_auth }
  retrieved docs (ranked): [ doc_billing, doc_auth, doc_faq ]
                              ▲
                              └─ top doc = doc_billing, NOT in relevant
  precision@1 = 0.0        ← the #1 result was wrong
```

P@1 is the strict signal: it punishes putting the wrong thing first even if the right
thing is at rank 2. That's the metric that matters most for a RAG agent told to "call
the tool first and ground in the top chunk."

**R@3 — did the relevant docs make the cut.** Recall@3 asks: of all the docs that
*should* have come back, how many landed in the top 3? It's lenient about rank,
strict about coverage.

```
  recall@3 — same query

  relevant: { doc_auth }              (1 relevant doc)
  top-3 docs: [ doc_billing, doc_auth, doc_faq ]
                              ▲
                              └─ doc_auth IS in the top 3
  recall@3 = 1/1 = 1.0     ← found it within the window
```

Same query scores P@1 = 0.0 and R@3 = 1.0 — the right doc was retrieved but ranked
second. Reading the two together is the skill: P@1 low + R@3 high means "retrieving
the right docs, ranking them wrong" (a reranking problem); both low means "not
retrieving them at all" (an embedding/index problem). That diagnostic split is what
makes the pair more useful than either alone.

**What the number can't see.** The eval calls `pipeline.query` and stops. It never
constructs the agent, never calls the model, never reads a `messages` row. So:

```
  the dark half — what a perfect P@1 still misses

  P@1 = 1.0  (right doc retrieved first)
        │
        ▼  ... and then the agent could still:
   - ignore the chunk and answer from the model's parametric memory
   - hallucinate a citation
   - hit the turn budget and emit FALLBACK_ANSWER
        │
        └─ eval sees NONE of this. answer quality is unmeasured.
```

This is the load-bearing limitation: a green eval is necessary, not sufficient. It
certifies the retriever, and the retriever is upstream of every answer problem but
causes only some of them.

### Move 3 — the principle

An eval measures exactly the layer it runs through and nothing downstream of where it
stops. buffr's eval stops at retrieval, so it's a *retrieval* regression guard wearing
the label "quality." That's not wrong — retrieval is the right first thing to pin,
because a RAG answer can't beat its retrieved context. The principle: *know which seam
your metric sits on, and never let a number for one layer stand in for the quality of
the layer above it.* P@1 going green tells you the context is good; it tells you
nothing about whether the model used it.

## Primary diagram

The eval path and its boundary in one frame.

```
  the eval — what it runs through, where it stops

  ┌─ eval-cmd.ts ─────────────────────────────────────────────────────┐
  │  load queries.json (query + relevant[])                           │
  │  for each query:                                                  │
  │     hits = pipeline.query(query, K=3)  ─────────────┐             │
  │     docs = unique docIds                            │             │
  │     P@1 = precision@1(docs, relevant)               │ scored here │
  │     R@3 = recall@3(docs, relevant)                  │             │
  │  print per-query + mean                  ───────────┘             │
  └───────────────────────────┬──────────────────────────────────────┘
                              │ STOPS HERE — boundary
  ┌─ agent.answer / model ────▼──────────────────────────────────────┐
  │  NEVER CALLED by eval. answer correctness = unmeasured.          │
  └───────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Run by hand via `npm run eval` after any change to retrieval — a new
embedding model, a different chunker, a tweaked `k`, more indexed docs. It's the
regression guard for "did I make retrieval worse." Deterministic (no model in the
loop), so the number is comparable run to run.

**The scoring loop — `src/cli/eval-cmd.ts:22-33`.**

```
  src/cli/eval-cmd.ts  (lines 22–33)

  const K = 3;
  for (const { query, relevant } of queries) {
    const hits = await pipeline.query(query, K);              ← retrieval ONLY
    const docs = [...new Set(hits.map((h) => String(h.meta.docId)))];  ← dedup to docs
    const p = scorePrecisionAtK(docs, new Set(relevant), 1).score;     ← P@1
    const r = scoreRecallAtK(docs, new Set(relevant), K).score;        ← R@3
    p1 += p; rk += r;
    process.stdout.write(`${query.padEnd(44)} P@1 ${p.toFixed(2)} R@${K} ${r.toFixed(2)}\n`);
  }
  process.stdout.write(`\nmean P@1 ${(p1/queries.length).toFixed(2)} mean R@${K} ...\n`);
       │
       └─ pipeline.query is the only system call. no RagQueryAgent, no model, no
          SupabaseTraceSink. the boundary in the diagram is this line: the eval
          never crosses from retrieval into generation.
```

**The labeled set — `eval/queries.json`.** `{ query, relevant: string[] }[]` — the
ground-truth doc ids per query (`eval-cmd.ts:19`). The eval is only as honest as this
file; the doc-id labels are why the score measures document retrieval, and the
`new Set(...)` dedup (line 24) is why the same doc's multiple chunks count once.

**Where the score is printed, not stored — `eval-cmd.ts:31,33`.** Like everything
else, the result goes to stdout (`04`). Nothing persists the numbers, so there's no
time series and no threshold — a regression is caught only if a human re-runs and
compares against a remembered baseline. That's the alert gap from `audit.md` lens 4.

## Elaborate

Precision@k and recall@k are textbook information-retrieval metrics, predating RAG by
decades — buffr applies them at the natural place, the retriever, because RAG made
retrieval quality a first-class product concern again. The honest framing: this is the
*right* metric for the *retrieval* layer and a *missing* metric for the *answer* layer.
The next rung is an answer-quality eval — an LLM-judge or rubric scorer over the
generated answer — which aptkit ships (`scoreRubric`/judge utilities exist in the
package), and which buffr hasn't wired up. That extension is owned by `../study-testing/`
as the AI-eval seam; here it's named as the gap above the retrieval eval. What to read
next: `../study-testing/` (the eval-as-correctness-harness view) and `02` (the *other*
signal — `model_usage`/latency — that exists but isn't captured).

## Interview defense

**Q: Your eval reports P@1 and R@3. What does a green eval actually certify?**
That retrieval is good — the right *documents* come back, ranked well. It certifies
nothing about the answer, because the eval calls `pipeline.query` and stops; it never
constructs the agent or the model. So P@1 = 1.0 and a hallucinated answer are
perfectly compatible. The number lives on the retrieval side of the
retrieval/generation seam, and I'd say exactly that rather than let it stand in for
end-to-end quality.

```
  P@1 / R@3  ──► retrieval layer    (certified)
                 ─────────────────
                 generation layer   (dark — eval stops above it)
```

**Q: P@1 is low but R@3 is high. What does that tell you, and what would you fix?**
The right docs are being retrieved but ranked wrong — they're in the top 3 but not at
position 1. That's a *ranking* problem, not a *retrieval* problem, so I'd reach for a
reranker or revisit the similarity scoring, not the embedding model. If both were low,
that flips: the docs aren't coming back at all, so it's the embedding or the index.
Reading the two metrics together is what localizes the fix.

## Validate

1. **Reconstruct.** Write the eval loop's four steps from memory: retrieve, dedup,
   score P@1, score R@3. (`src/cli/eval-cmd.ts:24-29`.)
2. **Explain.** Why can P@1 = 0.0 and R@3 = 1.0 for the same query? (Right doc
   retrieved but ranked below position 1.)
3. **Apply.** The eval is all green but users report wrong answers. Name the layer the
   eval can't see and one concrete failure that lives there. (Generation; e.g. the
   model ignores the retrieved chunk and answers from parametric memory — eval stops
   at `pipeline.query`, `eval-cmd.ts:26`.)
4. **Defend.** Argue what the *next* eval should measure and where it'd plug in.
   (Answer quality via an LLM-judge/rubric over `agent.answer` output; owned by
   `../study-testing/` as the AI-eval seam.)

## See also

- `02-discarded-trace-signal.md` — the latency/cost signal that exists but isn't kept.
- `04-stdout-as-only-log.md` — the eval scores are stdout-only, never persisted.
- `01-trajectory-capture-as-observability.md` — the answer the eval doesn't score is
  the one persisted as an assistant row.
- `../study-testing/` — the eval-as-correctness-harness view and the answer-quality gap.
