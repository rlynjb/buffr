# GraphRAG — entity-graph retrieval buffr doesn't do

*Industry standard (NOT yet exercised). Retrieval over a graph of entities, not just a pile of vectors.*

## Zoom out, then zoom in

Pull up buffr's retrieval and see its shape: a flat set of chunks, each an independent point in vector space, found by nearest-neighbor. There are no *connections* between chunks — no "this entity appears in these five docs," no "follow this relationship." GraphRAG adds exactly that: a graph of entities and relations you can *traverse*. buffr is pure vector RAG; there's no graph.

```
  Zoom out — the graph layer buffr is missing

  ┌─ Retrieval layer ──────────────────────────────────────────┐
  │  VECTOR RAG (buffr HAS): flat chunks, cosine ANN, no links  │
  │       chunk ●   chunk ●   chunk ●   ← independent points    │
  │  ┌─ GRAPH layer (MISSING) ────────────────────────────────┐ │
  │  │ ★ entities + relations, traversed ★                    │ │ ← here
  │  │   (no nodes, no edges, no traversal in buffr)          │ │
  │  └────────────────────────────────────────────────────────┘ │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in. You've built graphs and done traversals — BFS, adjacency, frontiers — so the structure is yours already. The concept is applying that to retrieval: extract *entities* from documents, link them into a knowledge graph, and answer questions by *walking edges* (this person → worked on → this project → mentioned in → these docs) instead of (or alongside) nearest-neighbor. buffr does none of it — but its soft `document_id` link and `meta` carry the seeds of a graph. This file builds GraphRAG, names the gap, and the Case-B move. Honest and short.

## Structure pass

Read the skeleton: two retrieval topologies — a flat point cloud vs a connected graph.

**Layers:** documents → (extraction) → retrieval units. buffr's units are isolated points; GraphRAG's are connected nodes.

**Axis traced — "what structure connects the retrieval units?"**

```
  one axis: how are retrieval units related?

  ┌─ buffr (vector RAG) ────┐   NONE — chunks are independent points;
  │  flat chunk set, cosine  │   "related" means only "geometrically near"
  └────────────┬────────────┘
               │ seam: no edges → can't follow relationships
  ┌─ GraphRAG (missing) ────┐   EDGES — entities linked by typed relations;
  │  knowledge graph, traverse│  "related" means "reachable by traversal"
  └─────────────────────────┘
```

**The seam that matters:** the boundary between *proximity* and *connection*. Vector RAG can answer "what's similar to X?" but not "what connects X to Y across documents?" — because similarity has no notion of a path. A multi-hop question ("who worked on the project that the person in this note founded?") needs *edges to follow*, and buffr's flat chunk set has none. Hold that: nearest-neighbor finds neighbors in space; only a graph finds neighbors in *meaning-relationships*.

## How it works

### Move 1 — the mental model

You've coded BFS over an adjacency list — frontier, visited set, expand neighbors. GraphRAG retrieval *is* that traversal, where nodes are entities pulled out of your documents and edges are relationships between them. Instead of "embed the query, return the 5 nearest chunks," it's "find the entities the query mentions, then walk their neighborhood to gather connected context."

```
  the GraphRAG kernel — traverse an entity graph

  query mentions "Passport Office"
       │ locate seed node
       ▼
  ┌─ knowledge graph ─────────────────────────┐
  │  (Passport Office) ──issues──► (Passport)  │
  │         │ located-in                       │
  │         ▼                                   │
  │  (City) ──has──► (Renewal Center) ◄─ docs  │
  └────────────────────────────────────────────┘
       │ BFS out k hops from seed
       ▼
  gather chunks attached to reached nodes → context (multi-hop!)
```

The kernel: nodes (entities) + typed edges (relations) + a traversal from query-seeds. Lose the edges and you're back to a flat set; lose the traversal and you have a graph you never walk. It's the same graph machinery you've built, applied to retrieval.

### Move 2 — the step-by-step walkthrough

**Step 1 — what buffr does today: a flat point cloud.** Retrieval is nearest-neighbor over independent vectors. No node, no edge, no traversal:

```ts
// src/pg-vector-store.ts:70-78
order by embedding <=> $1::vector    -- nearest points; no relationships followed
limit $3
```

Each chunk is an island. The only "relationship" buffr records is the soft `document_id` linking a chunk back to its parent document — and that's a single hop, not a traversable graph.

**Step 2 — where flat retrieval falls short.** A multi-hop question — "what's the deadline for the thing the office in my passport note handles?" — needs to connect *passport note* → *office* → *handles renewals* → *deadline*, possibly across different chunks in different documents. Cosine can't chain those: it finds chunks similar to the *whole question*, but if no single chunk contains the full chain, the answer is unreachable.

```
  Comparison — flat vector vs entity graph

  ┌─ buffr (vector) ─────────┐    ┌─ GraphRAG ─────────────────┐
  │ embed query → top-k near  │    │ seed entities → BFS edges   │
  │ single-hop similarity     │    │ multi-hop traversal         │
  │ no path between chunks     │    │ follows relationships       │
  │ "what's like X?"           │    │ "what connects X to Y?"     │
  └───────────────────────────┘    └────────────────────────────┘
```

**Step 3 — the Case-B seeds buffr already has.** Two things in buffr's schema can seed a graph without a rewrite. The soft `document_id` already groups chunks under documents (a star, not yet a graph), and the `meta jsonb` can hold extracted entities per chunk:

```sql
-- sql/001_agents_schema.sql:14-25 — the seeds
document_id text,              -- soft link: chunk → document (one edge type already)
...
meta jsonb not null default '{}'   -- could hold extracted entities/relations per chunk
```

The Case-B move: run an extraction pass (an LLM with `gemma2:9b` reads each chunk and emits entities + relations), store them as nodes/edges (a new `agents.entities` + `agents.edges` table, or in `meta`), and add a traversal retriever beside the vector one:

```
  // GraphRAG retrieval (the Case-B addition)
  function graphRetrieve(query):
      seeds = extractEntities(query)              // entities the query mentions
      frontier = seeds ; visited = {} ; gathered = []
      for hop in 1..maxHops:                      // BFS — your familiar traversal
          for node in frontier:
              visited.add(node)
              gathered += chunksAttachedTo(node)  // pull connected context
          frontier = neighborsOf(visited) - visited
      return gathered                              // multi-hop context
```

```
  Layers-and-hops — adding the graph retriever

  ┌─ index (NEW) ┐ hop 1: extract entities/relations  ┌─ gemma2:9b ──────┐
  │ extraction    │ ──────────────────────────────────►│ entities + edges │
  └──────┬────────┘                                     └──────────────────┘
         │ hop 2: store nodes/edges
         ▼
  ┌─ agents.entities + agents.edges (NEW tables) ──────────────────────┐
  │  traversal retriever: seed → BFS k hops → gather attached chunks   │
  └────────────────────────────────────────────────────────────────────┘
```

**Step 4 — the boundary condition: extraction is the hard, costly part.** A knowledge graph is only as good as its entity/relation extraction, which is an LLM pass over the whole corpus — expensive, error-prone, and a maintenance burden as documents change. That's why GraphRAG is a *heavy* upgrade: it's not just a retrieval tweak, it's a second derived dataset (the graph) that goes stale like embeddings do (`09`). For buffr's tiny personal corpus, it's likely over-engineering today — the honest call is "seeds are there, but it has to earn the cost."

### Move 3 — the principle

Vector retrieval answers "what's *similar*?"; graph retrieval answers "what's *connected*?" — and multi-hop questions need the second. The deeper idea: the retrieval *topology* should match the question shape. Flat questions ("find docs about X") want a point cloud; relational questions ("trace how X relates to Y") want a graph to traverse. buffr's flat topology is right for its current question shape and corpus size; GraphRAG is the answer when questions become multi-hop and the corpus is rich enough to extract a meaningful graph from. The general lesson: choose the retrieval structure for the question, not the other way around.

## Primary diagram

The graph layer buffr doesn't have, one frame:

```
  GraphRAG — entity-graph traversal buffr doesn't do

  VECTOR RAG (buffr HAS)              GRAPHRAG (MISSING)
  chunk ● chunk ● chunk ●            (entity)──relation──►(entity)
  flat points, cosine ANN                 │                  │
  single-hop similarity                  docs              docs
                                     BFS k hops → multi-hop context
  ───────────────────────────────────────────────────────────
  buffr seeds: soft document_id (one edge type) + meta jsonb (entities)
  Case B: LLM extraction (gemma2:9b) → entities/edges tables →
          traversal retriever beside the vector one.  Heavy: earns its cost.
```

## Elaborate

GraphRAG (popularized by Microsoft Research, 2024) emerged because pure vector RAG struggles with two question types: *multi-hop* questions that require chaining facts across documents, and *global* questions ("what are the main themes across the whole corpus?") that no single chunk answers. A knowledge graph plus community-summarization handles both — you traverse relationships for multi-hop, and summarize graph communities for global questions.

The cost is real: extraction is an LLM pass over the corpus, the graph is a second derived dataset to keep fresh, and the engineering is substantially more than "add a column." For buffr — a single laptop, a small personal markdown corpus, mostly single-hop questions — the honest assessment is that GraphRAG is *premature* today; the "above-threshold" rule from `11-rag.md` applies (don't add machinery a feature works without). But the seeds are genuinely present (the soft `document_id` link and the open `meta` field), so it's a clean future direction rather than a rewrite, and it's the right answer the day the questions go multi-hop. It also stacks with the rest: you'd typically use the graph to *expand* a vector retrieval (find seeds by cosine, then traverse), not replace it.

## Project exercises

> No `aieng-curriculum.md` is present in this repo, so Build-item IDs are not cited. Exercises are derived directly from the codebase and the spec's concept set.

### Extract an entity graph from the corpus

- **Exercise ID:** GRG-1 (Case B — buffr has no graph; build the seeds into one).
- **What to build:** an extraction pass that runs `gemma2:9b` over each chunk to emit entities and typed relations, stored in new `agents.entities` and `agents.edges` tables (or in the existing `meta jsonb`), keyed back to chunks via `document_id`.
- **Why it earns its place:** it turns the soft `document_id`/`meta` seeds into a real, queryable graph — the precondition for any traversal retrieval.
- **Files to touch:** new `src/cli/extract-graph-cmd.ts` (uses the Ollama generation provider), new tables in `sql/`, keyed to `agents.chunks.document_id` (schema `sql/001_agents_schema.sql:14-25`).
- **Done when:** running it produces entity and edge rows you can query, linked back to source chunks.
- **Estimated effort:** a day or more.

### Add a multi-hop traversal retriever

- **Exercise ID:** GRG-2 (Case B — walk the graph for multi-hop questions).
- **What to build:** a `graphRetrieve(query)` that seeds from query entities, BFS-traverses the GRG-1 graph k hops, gathers the attached chunks, and (ideally) fuses with the vector retriever — then measure precision@k on multi-hop queries vs vector-only.
- **Why it earns its place:** it's the actual GraphRAG payoff — answering questions vector-only can't — and it reuses the BFS traversal you already know.
- **Files to touch:** new `src/retrieval/graph-retrieve.ts` (BFS over `agents.edges` from GRG-1), wired beside `PgVectorStore.search` (`src/pg-vector-store.ts:67`) in `src/session.ts`.
- **Done when:** a multi-hop query that vector-only retrieval misses is answered via traversal, shown on a labelled eval case.
- **Estimated effort:** a day or more. Cross-link `../05-evals-and-observability/`.

## Interview defense

**Q: Does buffr do GraphRAG, and when would you reach for it?**
Answer: no — buffr is pure vector RAG: a flat set of chunks found by cosine nearest-neighbor, with no entities, edges, or traversal. You reach for GraphRAG when questions go *multi-hop* (chaining facts across documents — "who founded the project the person in this note worked on?") or *global* ("themes across the whole corpus") — both are things similarity can't do, because cosine finds points near the *whole query* but can't follow a *path*. The retrieval topology has to match the question shape.

```
  vector RAG: "what's similar to X?"   (single-hop, point cloud)
  GraphRAG:   "what connects X to Y?"  (multi-hop, traverse edges)
  buffr has only the first
```

**Q: What would it take to add GraphRAG to buffr, and is it worth it now?**
Answer: the seeds are there — the soft `document_id` link is already one edge type, and the `meta jsonb` can hold extracted entities — so it's a forward step, not a rewrite. You'd run an LLM extraction pass (`gemma2:9b`) to build entity/edge tables, then add a BFS traversal retriever beside the vector one. But it's heavy: extraction is a costly corpus-wide LLM pass and a second derived dataset that goes stale, so for a small single-hop personal corpus it's premature today — it has to earn its cost. The anchor: **the load-bearing judgment is that GraphRAG is the multi-hop answer, and adding it before questions are multi-hop is over-engineering.**

```
  seeds: document_id + meta → LLM extraction → entities/edges → BFS retriever
  heavy (corpus-wide extraction, stale graph) → earn the cost before adding
```

## See also

- `11-rag.md` — the vector RAG buffr actually runs (and the above-threshold rule).
- `04-vector-databases.md` — the soft `document_id` link that seeds a graph.
- `09-stale-embeddings.md` — the extracted graph is a second derived dataset that goes stale.
- `.aipe/study-dsa-foundations/` — BFS, adjacency, traversal: the machinery GraphRAG reuses.
