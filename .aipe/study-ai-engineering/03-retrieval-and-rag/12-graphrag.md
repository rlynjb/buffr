# GraphRAG

### *industry: GraphRAG / knowledge-graph retrieval · type: traversal-based retrieval over entities and relations*

## Zoom out

Every retrieval file so far ranks *independent chunks* by similarity. GraphRAG asks a different question: what if the relevant evidence is spread across chunks connected by *relationships* that no single chunk states? Then similarity isn't enough — you need to *traverse* a graph of entities. buffr has no graph at all.

**buffr's retrieval stack, the structured-retrieval gap marked**

```
┌──────────────────────────────────────────────────────────────┐
│  RAG pipeline           ranks independent chunks by cosine     │
├──────────────────────────────────────────────────────────────┤
│  ★ GRAPHRAG ★           traverse entities + relations          │  ◄── this file
│                         NOT IMPLEMENTED — no entity/relation    │
│                         extraction; meta.kind is the seed       │
├──────────────────────────────────────────────────────────────┤
│  agents.chunks          flat, similarity-ranked chunks         │
└──────────────────────────────────────────────────────────────┘
```

This is the most speculative file in the sub-section — buffr is the furthest from it. So it's pure mechanism: what a knowledge graph buys you over flat retrieval, what a multi-hop question looks like, and the one tiny seed in buffr (`meta.kind` tagging) that gestures toward structured retrieval.

## Structure pass

The axis is **what retrieval operates over**: a flat set of chunks vs. a graph of connected entities. The seam is the *relationship* — a fact that lives in the edges, not in any node.

**Flat chunks vs. entity graph**

```
   FLAT RETRIEVAL (buffr)            GRAPH RETRIEVAL (GraphRAG)
   ─────────────────────            ──────────────────────────
   chunks ranked independently       entities as nodes, relations
   by cosine                         as edges; retrieve by TRAVERSAL
   "find chunks like the query"      "find the subgraph around the query"
   ┌──────┐ ┌──────┐ ┌──────┐         (Alice)──works_at──►(Acme)
   │chunk │ │chunk │ │chunk │   ──►          │
   └──────┘ └──────┘ └──────┘            uses──►(TypeScript)
   no edges between them              edges ARE the retrievable facts
        the seam: is the answer IN a chunk, or BETWEEN chunks?
```

Left of the seam: each chunk is an island; retrieval finds the islands most similar to the query. A fact spanning two islands ("who uses the same stack as the author?") is invisible — no single chunk states it. Right of the seam: entities are nodes, relationships are edges, and retrieval *walks* the graph to assemble facts that no chunk contains alone. Consequence: flat RAG answers "what does a chunk say"; GraphRAG answers "what do the connections imply" — and buffr can only do the former.

## How it works

### Move 1 — Mental model: JOIN across a graph vs. SELECT from a pile

You know the difference between `SELECT * WHERE content LIKE …` (find rows matching text) and a multi-table `JOIN` (assemble a fact from related rows). Flat RAG is the first; GraphRAG is the second, over a graph. A multi-hop question is a JOIN across edges: start at an entity, follow relationships, collect what the path reveals.

**Multi-hop as graph traversal**

```
  question: "what tools does the author's coworker use?"
        │
        ▼ hop 1: find (author) ──manages──► (coworker)
        ▼ hop 2: (coworker) ──uses──► (tool X), (tool Y)
        ▼ answer assembled from a PATH, not one chunk
  ───────────────────────────────────────────────────
  flat RAG: no single chunk says "author's coworker uses X"
            ──► similarity search misses it
```

Frontend bridge: it's the difference between a flat search index and a normalized relational model with foreign keys. Search finds documents; the relational graph lets you *traverse* relationships to answer questions the documents never stated outright.

### Move 2 — Walk the mechanism

**Part A — Flat retrieval can't span relationships (buffr's honest state)**

buffr's chunks are independent rows ranked by cosine. There are no edges, no entities, no traversal. A relationship-shaped question degrades to "find the chunk most textually similar," which often isn't the answer.

**The flat-retrieval ceiling**

```
  agents.chunks
  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐
  │ c1   │ │ c2   │ │ c3   │ │ c4   │   ranked by cosine to query
  └──────┘ └──────┘ └──────┘ └──────┘
     ▲ no edges, no entities, no graph
  multi-hop question ──► returns the most SIMILAR chunk,
                         not the chunk reachable by traversal
```

```sql
-- sql/001_agents_schema.sql:14-25 — chunks are flat; no entities, no edges
create table if not exists agents.chunks (
  id text primary key, document_id text, …,
  content text, embedding vector(768), meta jsonb …   -- no entity/relation tables
);
```

The schema tells the whole story: there is no `entities` table, no `relations` table, no edge structure. buffr indexes *text similarity*, not *structured knowledge*. For its corpus of personal notes, flat retrieval is usually enough — but anything requiring "connect A to B through C" is out of reach.

**Part B — Building a graph would mean entity/relation extraction**

GraphRAG starts by running an extraction pass over the corpus: pull entities (people, tools, projects) and the relationships between them, store them as a graph, then retrieve by traversal *and* similarity.

**The extraction-then-traverse path (what's missing)**

```
  corpus chunks
        │ STAGE 1 (missing): LLM extracts entities + relations
        ▼
  (author)──uses──►(TypeScript)──with──►(Postgres)
  (author)──drinks──►(espresso)
        │ store as nodes + edges
        ▼ STAGE 2 (missing): retrieve subgraph around query entities
  answer assembled from the traversed subgraph
```

There's no buffr code to cite — this stage is entirely absent. Building it means an extraction pipeline (an LLM pass per chunk producing `(subject, relation, object)` triples), a place to store the graph, and a traversal-based retriever. That's a substantial addition, which is why buffr — a focused personal RAG agent — reasonably doesn't have it.

**Part C — The seed: `meta.kind` tagging is buffr's closest structured-retrieval primitive**

buffr does carry *one* structuring signal: chunks are tagged in `meta` (e.g. `kind=memory` for conversation-memory chunks). It's not a graph, but it's the same *instinct* — attaching structured labels to chunks so retrieval can reason over them.

**`meta.kind` as a proto-structure**

```
  agents.chunks.meta
  ┌────────────────────────────────────┐
  │ { kind: 'memory', docId, … }        │  ◄── conversation memory
  │ { docId, chunkIndex, text }          │  ◄── knowledge (untagged)
  └────────────────────────────────────┘
        ▲ a categorical label on each chunk
   the search tool's `filter` can already select by meta key
   (a flat, one-level "structure" — the smallest seed of a graph)
```

```ts
// aptkit search-knowledge-base-tool.ts:101-106 — filter over meta is the seed
function matchesFilter(hit, filter) {
  // selects chunks by exact meta key/value — a flat categorical filter,
  // the nearest thing buffr has to structured retrieval
  return Object.entries(filter).every(([k, v]) => !(k in hit.meta) || hit.meta[k] === v);
}
```

`meta.kind` plus the tool's `filter` is *categorical* retrieval — "give me memory chunks" — which is one flat level of structure. A knowledge graph is the rich version: not just a label, but typed entities and the edges between them. The seed is real; the leap to a graph is large.

### Move 2.5 — Current vs. future

**Case B: buffr has no entity/relation extraction and no graph. `meta.kind` is the closest seed.**

```
  TODAY                              GRAPHRAG (the gap)
  ─────                              ──────────────────
  flat chunks, cosine                entities + relations, traversal
  meta.kind = flat label             typed nodes + edges
  filter by meta (1 level)           multi-hop subgraph retrieval
  ┌──────────────────┐               ┌──────────────────────────────┐
  │ "find similar"    │               │ "find connected" + "similar"  │
  └──────────────────┘               └──────────────────────────────┘
   relationship questions miss        multi-hop questions answerable
```

The honest distance is large: from a categorical `meta` tag to a full extract-store-traverse pipeline is not a tweak, it's a new subsystem. For buffr's scope it may never be worth it — which is itself a defensible call.

### Move 3 — The principle

**GraphRAG trades retrieval simplicity for the ability to answer relationship questions — and that trade only pays when your questions are actually multi-hop.** Flat similarity retrieval answers "what does the corpus say about X." GraphRAG answers "how is X connected to Y" — but it costs an extraction pipeline, a graph store, and a traversal retriever. buffr's questions ("how do I take my coffee") are single-hop, so flat RAG is correctly sufficient. The skill is recognizing *when* a question is graph-shaped — and not building a knowledge graph for a corpus that never asks one.

## Primary diagram

Flat retrieval vs. the graph buffr doesn't have, with the seed marked.

**From flat chunks to a traversable graph**

```
  BUFFR TODAY                         GRAPHRAG (gap)
  ───────────                         ──────────────
  chunks + cosine                     extract (subject,relation,object)
   c1 c2 c3 c4   (flat)                       │ per chunk, via LLM
       │                                       ▼
   meta.kind tag ◄── the seed            (author)─uses─►(TS)─with─►(PG)
   (1-level structure)                   (author)─drinks─►(espresso)
       │                                       │ store nodes + edges
   filter by meta                              ▼
       │                              retrieve subgraph around query
       ▼                                       │ + cosine within it
   "find similar"                       "find connected" multi-hop answer
  ──────────────────────────────────────────────────────────────────────
  distance from seed to graph = a new extract/store/traverse subsystem
```

After the box: the gap isn't a feature flag, it's a subsystem — which is exactly why buffr's `meta.kind` is a *seed*, not a partial implementation.

## Elaborate

- **Hybrid graph+vector is the real-world shape.** Production GraphRAG rarely abandons embeddings — it uses the graph to find the *relevant region* (entities, their neighbourhood) and vectors to rank *within* it. So GraphRAG is additive to buffr's pipeline, not a replacement.
- **Extraction quality is the bottleneck.** A graph is only as good as the triples extracted from text. A weak local model producing noisy `(subject, relation, object)` triples builds a noisy graph — garbage edges in, wrong traversals out. For a laptop model, extraction quality is a real risk, not a given.
- **`meta` is genuinely extensible.** Because chunks carry arbitrary `meta` jsonb and the tool filters over it, you *could* tag chunks with extracted entities as a first step toward structure — without a full graph store. That's the incremental bridge from the seed.
- **Most personal-knowledge questions are single-hop.** The honest reason buffr skips this: "what do I do for work / how's my stack / how's my coffee" are all answerable from one chunk. GraphRAG earns its cost on corpora full of *relationships between many entities* (org charts, research literature, codebases) — not three markdown notes.

## Project exercises

### Extract entities into chunk metadata (the incremental seed → structure step)

- **Exercise ID:** [B2B.14] (cite [C2.11], Phase 2B) — Case B: buffr has **no entity extraction**. This is the primary, *bounded* first step toward GraphRAG.
- **What to build:** An index-time LLM pass that extracts named entities from each chunk and writes them into `meta` (e.g. `meta.entities = [...]`), then use the existing `search_knowledge_base` `filter` to retrieve by entity. No graph store yet — just enrich the seed.
- **Why it earns its place:** It's the smallest real move from `meta.kind` toward structured retrieval, reuses buffr's existing `meta` + `filter` machinery, and is achievable without a new subsystem. It also surfaces extraction quality early.
- **Files to touch:** the index path (`src/runtime.ts` / `src/cli/index-cmd.ts`) to add the extraction pass; reuse `GemmaModelProvider`; entities land in `agents.chunks.meta`.
- **Done when:** Chunks carry extracted entities in `meta`, and a `filter` query by entity returns the right chunks — measured against a small hand-labeled set.
- **Estimated effort:** 1–2 days.

### Build a relation graph + multi-hop retriever (the full gap)

- **Exercise ID:** [B2B.15] (cite [C2.11], Phase 2B) — Case B: the full GraphRAG subsystem. Scoped honestly as large.
- **What to build:** Extend extraction to `(subject, relation, object)` triples, store them as nodes/edges (a Postgres edge table or a graph store), and add a retriever that walks the subgraph around a query's entities, ranking within it by cosine. Evaluate on a multi-hop question the flat pipeline misses.
- **Why it earns its place:** It's the only thing that makes relationship/multi-hop questions answerable — but it's a new subsystem, so it's the *aspirational* target, justified only if buffr's corpus grows graph-shaped questions.
- **Files to touch:** new `entities`/`relations` tables in `sql/001_agents_schema.sql`, an extraction + graph-build pipeline, a traversal retriever alongside `src/pg-vector-store.ts`.
- **Done when:** A multi-hop query that flat RAG answers wrong is answered correctly via traversal, on a small labeled multi-hop eval.
- **Estimated effort:** 1–2 weeks.

## Interview defense

**Q: "When does flat RAG fail and GraphRAG win?"**

On multi-hop, relationship questions — "what tools does the author's coworker use." No single chunk states that; flat similarity returns the most similar chunk, not the answer. GraphRAG extracts entities and relations, then *traverses* edges to assemble a fact spread across chunks.

```
  answer IN a chunk ──► flat RAG
  answer BETWEEN chunks (edges) ──► GraphRAG traversal
```

Anchor: *"Flat RAG finds chunks; GraphRAG follows connections."*

**Q: "What's buffr's closest thing to structured retrieval, and why not go further?"**

`meta.kind` tagging plus the tool's `filter` — flat, one-level categorical retrieval (e.g. select memory chunks). A real graph needs an extraction pipeline, a graph store, and a traversal retriever — a new subsystem. buffr's questions are single-hop, so flat RAG is correctly sufficient; a graph would be cost without payoff.

```
  meta.kind + filter = 1-level seed
  full graph = extract + store + traverse (new subsystem)
```

Anchor: *"Don't build a graph for a single-hop corpus."*

## See also

- `./11-rag.md` — the flat pipeline GraphRAG would augment, not replace.
- `./04-vector-databases.md` — `meta` jsonb and the `filter` path that seed structured retrieval.
- `./05-dense-vs-sparse.md` — production GraphRAG fuses graph traversal *with* vector ranking.
- `../../study-database-systems/` — graph/edge modeling, recursive traversal, JOIN semantics.
- `../../study-dsa-foundations/` — graphs, traversal (BFS/DFS), and multi-hop pathfinding.
