# Dense vs Sparse Retrieval

### *industry: dense (embedding) vs sparse (lexical/BM25) retrieval · type: the two ways to score relevance*

## Zoom out

Same store, same query path — but now we question the *scoring function itself*. buffr ranks by cosine over embeddings (dense). There's a whole other family — keyword/lexical scoring (sparse, BM25) — that buffr doesn't use at all. This file is about what that costs.

**buffr's retrieval stack, the scoring choice marked**

```
┌──────────────────────────────────────────────────────────────┐
│  search_knowledge_base  ranked hits                            │
├──────────────────────────────────────────────────────────────┤
│  ★ SCORING ★            PURE DENSE — cosine over 768-dim only  │  ◄── this file
│                         (no BM25, no keyword scoring)          │
├──────────────────────────────────────────────────────────────┤
│  PgVectorStore          order by embedding <=> query           │
└──────────────────────────────────────────────────────────────┘
```

You built a dense RAG app, so dense is your default instinct. Good — but it has a specific blind spot, and the fix (sparse) is the thing you've probably never wired. This file names the blind spot precisely and shows where sparse would slot in.

## Structure pass

The axis is **what "match" means**: shared meaning vs. shared tokens. The seam is the moment a query's intent diverges from its exact words.

**Two definitions of relevance**

```
   DENSE (buffr)                     SPARSE (BM25, not in buffr)
   ────────────                      ───────────────────────────
   match = similar MEANING           match = shared exact TERMS
   "coffee" ≈ "espresso, oat milk"   "PG_a1b2" == "PG_a1b2"
   cosine over embeddings            term-frequency / inverse-doc-freq
   great on paraphrase               great on exact strings, ids, codes
   ┌──────────────────┐              ┌──────────────────┐
   │ embedding <=> q  │   ──seam──►  │ tsvector @@ tsq  │  (Postgres FTS)
   └──────────────────┘              └──────────────────┘
        the seam: does the query mean it, or does it say it literally?
```

Left of the seam: dense shines when the query *means* what a doc says without sharing words — paraphrase, synonyms, intent. Right of the seam: sparse shines when the query contains an *exact token that must match* — an error code, a function name, a SKU, a rare proper noun. Consequence: a pure-dense system like buffr can fumble exact-string queries that a one-line keyword index would nail.

## How it works

### Move 1 — Mental model: a semantic search bar vs. Ctrl-F

Dense retrieval is a search box that understands intent — type "how I caffeinate" and it finds the coffee doc. Sparse retrieval is Ctrl-F with smarts — type the exact token `nomic-embed-text:v1.5` and it finds every doc containing that literal string, ranked by how distinctive the term is. You want both, because users do both.

**When each wins**

```
  query: "how does the author take coffee"   ──► DENSE wins
          (intent, no rare exact token)           paraphrase-friendly

  query: "PgVectorStore.assertDim"            ──► SPARSE wins
          (exact identifier, must match)           dense may blur it into
                                                   "vector store error checks"
```

Frontend bridge: it's fuzzy search vs. exact filter in a command palette. Fuzzy gets you "settings" from "stngs"; exact gets you the file literally named `config.ts`. A good palette does both; buffr currently does only fuzzy.

### Move 2 — Walk the mechanism

**Part A — buffr is pure dense (the honest state)**

There is exactly one scoring path. The store orders by cosine distance, full stop. No `tsvector`, no BM25, no keyword column.

**The single scoring path**

```
  query ──► embed (768) ──► order by embedding <=> $1 ──► top-k
                            ▲
                  the ONLY relevance signal buffr has
                  (no lexical channel exists)
```

```ts
// src/pg-vector-store.ts:74-76 — cosine is the whole ranking
`order by embedding <=> $1::vector
 limit $3`
```

That `order by` is buffr's entire relevance model. There is no second clause that would say "and also boost rows containing the query's literal terms." A query whose key signal is an exact token has to survive on whatever *semantic* echo that token leaves in the embedding — which for a rare identifier is often weak.

**Part B — Where dense quietly fails**

Embeddings smear exact tokens into nearby meaning. A 768-dim vector for `"PG_ERR_4012"` doesn't preserve that exact string — it lands somewhere near "Postgres error code," close to *other* error codes too. Dense retrieval can therefore rank a *different* error code above the exact one you asked for.

**The exact-token blind spot**

```
  query: "PG_ERR_4012"
        │ embed
        ▼
  vector ≈ "postgres error code" region
        │ cosine
        ▼
  ranks:  PG_ERR_4015  (0.91)   ◄── wrong code, but semantically nearby
          PG_ERR_4012  (0.90)   ◄── the right one, NOT on top
          PG_ERR_4009  (0.89)
   sparse would put 4012 first: exact term match dominates
```

This isn't hypothetical hand-waving — it's the structural reason dense-only systems add a lexical channel. The embedding is a lossy compression of meaning (file 01), and exact strings are precisely the information that compression throws away.

### Move 2.5 — Current vs. future

**Case B: buffr has no sparse retrieval. Postgres can do it natively; nothing wires it.**

```
  TODAY                              ADD SPARSE (this is the gap)
  ─────                              ────────────────────────────
  dense only:                        keep dense, ADD a lexical channel:
  order by embedding <=> q           Postgres FTS: to_tsvector(content)
                                     query: tsvector @@ plainto_tsquery
  ┌──────────────────┐               ┌──────────────────────────────┐
  │ one signal:      │               │ two signals: cosine + BM25-ish │
  │ cosine           │   ──gap──►    │ then FUSE (see 06-hybrid)      │
  └──────────────────┘               └──────────────────────────────┘
   exact tokens ──► weak             exact tokens ──► strong
```

Postgres already ships full-text search (`to_tsvector` / `ts_rank`) — buffr just doesn't use it. Adding a lexical channel is a column + a GIN index + a second `order by`, *not* a new datastore. The remaining question is how to combine the two rankings, which is the next file (06, RRF). Sparse alone is the missing channel; fusing it is the next step.

### Move 3 — The principle

**Dense and sparse fail in opposite directions, so the strong systems run both.** Dense forgives wording and forgets exact tokens; sparse demands exact tokens and ignores intent. buffr being pure dense is fine for its current corpus — personal markdown notes, mostly paraphrase-shaped queries — but it has a named, structural weakness on exact identifiers. Knowing *which* failures are dense-shaped is the skill; the fix is to add the channel that doesn't share the weakness.

## Primary diagram

The single channel buffr has, and the second one it's missing.

**One scoring channel, where the second belongs**

```
  query
    │
    ├──► DENSE (buffr has this) ──► embed ──► cosine over agents.chunks ──► ranking A
    │
    └──► SPARSE (buffr lacks this) ─► tsvector @@ tsquery ──► ts_rank ──► ranking B
                                       (Postgres FTS, not wired)
    ──────────────────────────────────────────────────────────────────
    today: only ranking A reaches the model
    next:  fuse A + B (06-hybrid-retrieval-rrf) so exact tokens survive
```

After the box: buffr ships ranking A alone. The exact-token failure mode is the price, and the fix is a lexical ranking B that Postgres can produce natively.

## Elaborate

- **Why BM25 is called "sparse."** A lexical representation is a giant vector with one slot per vocabulary term, almost all zeros — sparse. A dense embedding is 768 mostly-nonzero floats. The names describe the vectors' density, and the densities reflect what they encode: terms vs. meaning.
- **buffr's corpus hides the weakness.** work.md/stack.md/coffee.md are prose with paraphrase-friendly queries — dense's home turf. Point buffr at a codebase or a log corpus full of identifiers and the exact-token gap would bite immediately.
- **Sparse is also cheaper and more debuggable.** A BM25 hit is explainable ("matched because it contains `assertDim` 4×"); a cosine hit is opaque. For exact-match queries, sparse is both better *and* more legible.
- **You rarely choose one — you weight them.** The mature move isn't dense-or-sparse, it's dense-and-sparse with a fusion rule. That's why this file's gap leads directly into hybrid retrieval rather than "swap to BM25."

## Project exercises

### Add a Postgres full-text (sparse) channel alongside cosine

- **Exercise ID:** [B2B.2] (cite [C2.4], Phase 2B) — Case B: buffr is pure dense. Sparse retrieval is **not implemented**; this is the primary target.
- **What to build:** Add a `tsvector` column (or expression index) over `chunks.content`, a GIN index, and a `searchLexical(query, k)` method on `PgVectorStore` that ranks by `ts_rank`. Return the same `Hit` shape so it's drop-in.
- **Why it earns its place:** It's the missing channel, and Postgres does it natively — no new infrastructure. It directly closes the exact-token blind spot this file names.
- **Files to touch:** `sql/001_agents_schema.sql` (tsvector + GIN index), `src/pg-vector-store.ts` (a lexical search method).
- **Done when:** A query for an exact identifier in the corpus ranks the exact-match chunk first via the lexical channel, where dense ranked it lower.
- **Estimated effort:** 1 day.

### Build an exact-token eval to expose the dense gap

- **Exercise ID:** [B2B.3] (cite [C2.4], Phase 2B) — Case B prerequisite that justifies adding sparse.
- **What to build:** Extend `eval/queries.json` with queries that hinge on exact tokens (an identifier, a version string) and measure dense P@1 on them. Quantify how often pure-dense misses the exact match.
- **Why it earns its place:** The dense weakness is asserted here, not measured in buffr. You need the miss-rate on *your* corpus before sparse earns its place.
- **Files to touch:** `eval/queries.json`, `src/cli/eval-cmd.ts`.
- **Done when:** The eval shows a measurable dense P@1 drop on exact-token queries vs. paraphrase queries.
- **Estimated effort:** 1–4hr.

## Interview defense

**Q: "buffr is dense-only — when does that hurt?"**

On exact-token queries — identifiers, error codes, version strings. Embeddings compress meaning and lose exact strings, so cosine can rank a semantically-nearby-but-wrong token above the literal match. Sparse/BM25 would nail it because it scores exact term overlap.

```
  dense ──► great on paraphrase, blurs exact tokens
  sparse ──► great on exact tokens, ignores intent
```

Anchor: *"Dense forgets the exact word; sparse demands it."*

**Q: "Why not just switch to sparse then?"**

Because sparse loses intent — it can't match "how I caffeinate" to a coffee doc with no shared words, which is most of buffr's queries. The answer isn't dense-or-sparse, it's both, fused. Postgres can produce the lexical channel natively.

```
  switch to sparse ──► lose paraphrase matching
  add sparse + fuse ──► keep both strengths
```

Anchor: *"Don't switch channels — add one."*

## See also

- `./06-hybrid-retrieval-rrf.md` — how to fuse the dense and sparse rankings (the natural next step).
- `./01-embeddings.md` — why the embedding is lossy on exact strings in the first place.
- `./04-vector-databases.md` — Postgres already hosts the FTS this gap needs.
- `../../study-database-systems/` — full-text search, tsvector, GIN indexes.
