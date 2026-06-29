# 03 — Retrieval Routing

*Industry standard: **retrieval routing / query routing** — NOT YET implemented in buffr.*

---

## Zoom out → zoom in

This is rung 3 of agentic retrieval: before you search, decide *which source* to search.

```
  Section B layers — file 03 is the last escalation, and buffr's most degenerate case

  ┌─ Agent loop (Section A) ───────────────────────────────────┐
  │  ┌─ 01 agentic RAG — model calls search 0..4×, then answers┐│  [IMPLEMENTED]
  │  ├─ 02 self-corrective — grade chunks, retry on a miss ────┤│  [NOT YET]
  │  ├─ ★ 03 RETRIEVAL ROUTING ★ — pick the SOURCE per query ──┤│  ← YOU ARE HERE
  │  │     vector? SQL? web? the right tool for THIS question  ││     [NOT YET — 1 source]
  │  └────────────────────────────────────────────────────────┘ │
  └─────────────────────────────────────────────────────────────┘
```

**The honest one sentence: buffr does NOT route — it has exactly one knowledge source
(pgvector), so there is no router choosing between a vector store, a SQL database, and a web
search.** Agentic RAG (file 01) already lets the model pick *whether* and *what* to search.
Routing adds a prior decision: *where.* A question like "what's my account balance" wants a
SQL lookup; "what did the docs say about X" wants the vector store; "what's the weather"
wants the web. A router sends each query to the source that can actually answer it.

---

## Structure pass

Trace ONE axis: **how many sources the query can land in.** buffr's answer is one — which is
why its router is degenerate (no choice to make).

```
  The axis: source cardinality

  BUFFR (1 source)                   ROUTED RAG (N sources)
  ────────────────                   ──────────────────────
  query                              query
     │                                  │
     ▼                                  ▼
  search_knowledge_base              ┌─ ROUTE: classify the query ─┐   ◄── SEAM
     │                               │   │       │        │        │       the router
     ▼                               │   ▼       ▼        ▼        │
  pgvector (HNSW cosine)             │ vector   SQL      web       │
     │                               │ store   store   search      │
     ▼                               └───┬───────┬────────┬────────┘
  chunks ──► answer                      └───────┴────────┴──► answer

  no choice — the route is a            the router picks 1 (or more) of N
  straight line                         based on what the query needs
```

The seam is the router — a classifier (LLM call, keyword rules, or an embedding
similarity-to-source) that maps a query to a source *before* retrieval runs. buffr has no box
at that seam because it has nothing to route between.

---

## How it works

### Move 1 — the mental model

Think of a frontend request layer that hits different backends depending on the resource: a
`switch` on the route that calls `/api/users` vs `/api/search` vs a third-party API. The
router is that `switch`, and the query is the thing being switched on.

```
  PATTERN: classify the query, dispatch to the matching source

  query ──► router.classify(query) ──► sourceId
                                          │
            ┌─────────────────┬───────────┴────────┐
            ▼                 ▼                      ▼
        VECTOR             SQL                    WEB
   "semantic recall"  "structured facts"   "fresh / external"
        │                  │                       │
        └──────────────────┴───────────────────────┴──► chunks ──► answer
```

The router's job is matching the *shape of the question* to the *shape of the source*.
Semantic/fuzzy → vector. Exact/structured → SQL. Recent/external → web. Everything else in
agentic RAG stays the same; routing just precedes it.

### Move 2 — step by step

**Part 1 — The router: a classifier in front of retrieval.**

The router takes a query and returns which source(s) to hit. It can be an LLM call ("which
of these sources best answers this?"), keyword rules, or embedding similarity between the
query and a description of each source.

```
  Part 1 diagram: the router as a dispatch step (and buffr's missing box)

  buffr today:   query ──────────────────► search_knowledge_base (pgvector only)
                       ▲
                       └─ [ NO ROUTER — only one destination exists ]

  routed RAG:    query ──► route(query) ──► { vector | sql | web } ──► retrieve
```

Bridge from known: it's a `switch(route)` that picks an endpoint, except the cases are data
sources and the discriminator is the query's intent rather than a URL path.

Pseudocode first:

```
function routedRetrieve(query):
    source = router.classify(query)      # the new step: vector | sql | web
    switch source:
        case VECTOR: return vectorStore.search(query)
        case SQL:    return sqlStore.lookup(query)
        case WEB:    return webSearch(query)
```

buffr collapses this to its first case only — there is no `router.classify`, just one tool.
The dispatch happens at tool-registration time, not query time:

```ts
// buffr/src/session.ts:42-44
const pipeline = createRetrievalPipeline({ embedder, store });        // ONE store: PgVectorStore
const tool = createSearchKnowledgeBaseTool(pipeline, { minTopK: 4 }); // ONE tool over it
const tools = new InMemoryToolRegistry([tool.definition], {           // registry holds exactly one
  [tool.definition.name]: tool.handler,                              // search_knowledge_base
});
```

And the agent's policy grants exactly that one tool — there is nothing else it *could* route
to:

```ts
// aptkit/packages/agents/rag-query/src/rag-query-agent.ts:14-18
/** Least-privilege grant: this agent may only search the knowledge base. */
export const ragQueryToolPolicy: ToolPolicy = {
  capabilityId: RAG_QUERY_CAPABILITY_ID,
  allowedTools: [SEARCH_KNOWLEDGE_BASE_TOOL_NAME],   // ← the entire tool set: one
};
```

**Part 2 — The honest nuance: two row-types, one store, no router between them.**

Here's the part that makes buffr's "no routing" claim more interesting than it sounds. buffr
actually has *two kinds of content* — indexed document chunks and episodic memory of past
conversations — and they live in the **same** PgVectorStore, reached through the **same**
`search_knowledge_base` tool. There is no router deciding "is this a memory question or a
docs question." Both are answered by one semantic search over one store.

```
  Part 2 diagram: two row-types, one store, NO router between them

   document chunks ───┐
   (indexed docs)     ├──► PgVectorStore ──► search_knowledge_base ──► both surface
   memory rows ───────┘     (tagged kind=memory      (one tool)         together by
   (past exchanges)          vs document)                              relevance, unrouted
```

The wiring that makes memory share the store and the tool:

```ts
// buffr/src/session.ts:49-53 (comment) + 53
// Retrievable episodic memory over buffr's own store. ... Sharing the document
// store means memory surfaces via the existing search_knowledge_base tool — and
// memory chunks live with no documents row, which the dropped FK allows.
const memory = createConversationMemory({ embedder, store });   // SAME store injected
```

So buffr unifies rather than routes: instead of a router sending memory-questions to a memory
index and docs-questions to a docs index, everything goes into one vector space and the
nearest chunks win — whether they're documents or remembered exchanges. That's a legitimate
design (one search surface, relevance decides), not a missing feature. It's covered more in
`04-agent-infrastructure` where the memory tier is the subject; here the point is just:
*shared store + shared tool = no routing seam, on purpose.*

**Part 3 — What routing would add, and where it slots in.**

Routing earns its keep the moment a second source exists that the vector store *can't*
answer well: structured/transactional facts (SQL), or fresh/external info (web). At that
point you need a query-time decision.

```
  Part 3 diagram: the refactor — from one tool to a routed tool set

  TODAY:                          ROUTED:
  registry = [ search_kb ]        registry = [ search_kb, query_sql, web_search ]
       │                                 │
       ▼                                 ▼
  policy allows: [search_kb]      policy allows all three
       │                                 │
       ▼                                 ▼
  model calls the one tool        model (or a router step) picks the right tool
```

The two clean ways to add it, both already supported by the architecture:
- **Model-as-router** — register `query_sql` and `web_search` as additional tools, widen
  `ragQueryToolPolicy.allowedTools`, and let the model's tool choice *be* the route. Cheapest;
  reuses the existing loop. This is agentic RAG's native extension point.
- **Explicit router step** — a classifier before `runAgentLoop` that selects the tool subset
  to expose. More control, more cost. This is the Section F template's shape.

The insertion point is exactly where the tool registry is built (`session.ts:44`) and where
the policy is declared (`rag-query-agent.ts:15-18`) — add tools, widen the grant.

### Move 3 — the principle

**Route the query to the source that can answer it, before you spend a retrieval on the
wrong one.** A vector store is a hammer; not every question is a nail. Routing is the
admission that different question shapes need different stores. buffr sidesteps the question
by having one store — and unifies its two row-types into it rather than routing between them.

---

## Primary diagram (recap)

The gap, framed against buffr's deliberate one-source unification.

```
  Routed RAG vs buffr's one-source unification

  ROUTED RAG (not yet)                    BUFFR TODAY (one source, unified)
  ════════════════════════                ═══════════════════════════════════════
   query                                   query
      │                                       │
      ▼                                        ▼
   ROUTE: classify ──► vector                search_knowledge_base
      │            ├──► SQL                       │  (the only tool; policy grants only it)
      │            └──► web                        ▼
      ▼                                         PgVectorStore (HNSW cosine)
   the right source per query                     ├─ document chunks ─┐
      │                                           └─ memory rows ──────┤ same space,
      ▼                                                                 ▼ relevance decides
   answer                                       chunks ──► answer   (NO router between them)
```

buffr's design choice is unification, not routing: one store, one tool, two row-types blended
by similarity. Routing is what you reach for when a second store appears that semantic search
can't serve.

---

## Elaborate

**Why one source is the right call for buffr right now.** A personal knowledge assistant over
documents-you-indexed has, by construction, one natural source: the semantic store. There's
no transactional database to query and (deliberately, for a local-first privacy posture) no
web reach. Adding a router with one destination is pure overhead — a `switch` with one case.
buffr correctly doesn't pay it.

**The unification is a feature, not a gap.** Folding episodic memory into the same vector
space means "what did I say last week about X" and "what do my docs say about X" are answered
by the same search, ranked together by relevance. A routed design would force you to decide,
per query, whether it's a memory question or a docs question — a brittle classification buffr
avoids by letting the vector space decide. The cost: you can't *force* a memory-only or
docs-only search without a metadata filter (which the tool's `filter` arg, at
`search-knowledge-base-tool.ts:67-71`, technically allows but the model rarely uses).

**When routing becomes necessary.** The trigger is a second source with a different access
shape: a SQL store for structured facts, or web search for fresh data. The day either lands,
the model can no longer answer everything with one semantic lookup, and you need a query-time
source decision. Until then, routing is a pattern to *name*, not to *build*.

---

## Interview defense

**Q: "You said it's agentic RAG — does the agent route between knowledge sources?"**

> No, and the honest reason is it only has one: a single PgVectorStore reached through one
> `search_knowledge_base` tool, and the agent's policy grants exactly that one tool. So
> there's no router between a vector store, a SQL database, and web search — there's nothing
> to route between. The nuance I'd add unprompted: buffr actually has *two* content types —
> indexed document chunks and episodic conversation memory — and instead of routing between
> them, it unifies them into the same vector space behind the same tool. Relevance decides
> which surfaces, not a router. That's a deliberate one-source design, not a missing feature.
> Routing is the refactor I'd reach for the moment a second source appears that semantic
> search can't serve — a SQL store or web search — and the cheapest version is just
> registering those as extra tools and letting the model's tool choice be the route.

```
  The defense in one diagram

  "does it route?"  ──► NO ──► why? ──► one source (pgvector), one tool, policy grants only it
                                  │
                                  └─ nuance ──► two row-types (docs + memory) UNIFIED in one
                                               store, not routed — relevance decides
                                  │
                                  └─ when to add ──► a 2nd source SQL/web appears →
                                               register as tools, widen the policy
```

**Anchor it in code:** the one tool and store at `session.ts:42-44`; the single-tool policy
at `rag-query-agent.ts:14-18`; the shared-store memory unification at `session.ts:49-53`; the
unused `filter` arg that could simulate row-type routing at `search-knowledge-base-tool.ts:67-71`.

---

## See also

- `01-agentic-rag.md` — the implemented pattern; the model's tool choice is already a
  degenerate route over a one-tool set, which is why model-as-router is the cheap extension.
- `02-self-corrective-rag.md` — the web-fallback escalation mentioned there is itself a
  routing decision (escalate the source when the local store fails).
- `../04-agent-infrastructure/` — the memory tier; where the two-row-type / one-store
  unification is the main subject rather than a routing footnote.
- `../06-orchestration-system-design-templates/` — Section F's multi-source template; the
  shape buffr would adopt to add SQL/web routing.
- **`study-ai-engineering`** — hybrid search and source-selection mechanics underneath a
  router. This file does not re-teach them.
