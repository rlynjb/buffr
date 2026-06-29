# 01 — Agentic RAG

*Industry standard: **agentic retrieval-augmented generation** — implemented pattern.*

---

## Zoom out → zoom in

This file is the spine of the whole section: it is the one pattern buffr actually runs.

```
  Section B layers — file 01 is the implemented floor everything else escalates from

  ┌─ Agent loop (Section A) ───────────────────────────────────┐
  │  runAgentLoop — model decides search-or-answer each turn   │
  │  ┌─ ★ 01 AGENTIC RAG ★  — the model drives retrieval ────┐ │  ← YOU ARE HERE
  │  │     calls search_knowledge_base 0..4×, then answers   │ │     [IMPLEMENTED]
  │  ├─ 02 self-corrective — grade chunks, retry on a miss ──┤ │     [NOT YET]
  │  ├─ 03 routing — pick the right SOURCE per query ────────┤ │     [NOT YET]
  │  └────────────────────────────────────────────────────────┘ │
  └─────────────────────────────────────────────────────────────┘
```

In AdvntrCue you ran retrieval *once*, outside the model, and handed it the chunks. buffr
moves the retrieve step *inside* the model's control loop: the model issues the search
call, reads the results, and decides whether that's enough to answer or whether it needs to
search again. The retrieval is the same pgvector lookup you already know — what changed is
*who decides when it runs*. The verdict up front: **buffr runs agentic RAG, which is just
"a ReAct loop whose primary tool is retrieval."**

---

## Structure pass

Trace ONE axis: **who decides when retrieval happens.** That is the axis that flips between
static RAG and agentic RAG, and it flips at exactly one seam.

```
  The axis: control over the retrieve step

  STATIC RAG (AdvntrCue)            AGENTIC RAG (buffr)
  ─────────────────────            ───────────────────
  engineer's code decides          the MODEL decides
  retrieve runs exactly once       retrieve runs 0..N times
  before the model sees anything   whenever the model emits a tool call

         retrieve                         ┌──────────────┐
            │                             │ model turn   │
            ▼                             │  search?     │──no──► answer
        [chunks]                          │   │ yes              ▲
            │                             │   ▼                  │
         generate                         │ retrieve ──results──►┘ (loop)
            │
         answer                       SEAM: the tool-call boundary —
                                      retrieval became a TOOL, not a step
```

The seam is the tool-call boundary. In static RAG the chunks arrive in the prompt by the
time generation starts; the model never *asks*. In agentic RAG the model asks — it emits a
`search_knowledge_base` tool call, the loop runs the retrieval, feeds results back as a
tool result, and the model gets another turn to decide. Same vector store on both sides; the
control inverted.

---

## How it works

### Move 1 — the mental model

Think of the `.then()` chain you wrote in AdvntrCue, then imagine the model holding the
chain and choosing how many times to run the middle link.

```
  PATTERN: retrieval as a tool the model calls in a loop

  ┌──────────────────────────────────────────────────────────────┐
  │  loop turn (model.complete)                                   │
  │     │                                                         │
  │     ├─ emits text only ──────────────────► DONE (final answer)│
  │     │                                                         │
  │     └─ emits tool_use: search_knowledge_base                  │
  │             │                                                 │
  │             ▼                                                 │
  │         run retrieval (pgvector HNSW cosine top-k)            │
  │             │                                                 │
  │             ▼                                                 │
  │         tool_result: ranked chunks + citations ──► next turn  │
  └──────────────────────────────────────────────────────────────┘
       budget: up to 4 search calls across up to 6 turns,
       then tools are stripped and a final answer is forced
```

The model is the controller. The search tool is a pure function it can call. The loop is the
clock that bounds how long the model gets to keep calling it. Hold those three pieces — they
are the whole pattern.

### Move 2 — step by step

**Part 1 — The tool: retrieval wrapped as a callable.**

In AdvntrCue, retrieval was a function *you* called. In buffr it is a function the *model*
calls — which means it needs a name, a description, and a JSON input schema the model can
target, not just a signature.

```
  Part 1 diagram: the search tool as a model-callable contract

  model sees ──► { name: "search_knowledge_base",
                   description: "Search the indexed knowledge base...",
                   inputSchema: { query, top_k, filter } }
                          │
                          ▼ model emits args { query: "...", top_k: 5 }
                   handler(args) ──► pipeline.query() ──► ranked chunks
                          │
                          ▼ enforce floor: topK = max(requested, minTopK)
                   results: [{ id, score, citation, meta }, ...]
```

The bridge from what you know: a `fetch()` wrapper exposes a URL and parses the response;
this exposes a *schema* and parses the model's chosen `args`. Real code, side by side:

```ts
// aptkit/packages/retrieval/src/search-knowledge-base-tool.ts:53-76
const definition: ToolDefinition = {
  name: SEARCH_KNOWLEDGE_BASE_TOOL_NAME,             // 'search_knowledge_base' (line 6)
  description:
    'Search the indexed knowledge base for passages relevant to a query and ' +
    'return ranked chunks with citations.',          // ← this string IS the model's API doc
  inputSchema: {
    type: 'object',
    properties: {
      query:  { type: 'string',  ... },              // the model writes the query
      top_k:  { type: 'integer', default: DEFAULT_TOP_K },  // and chooses how many
      filter: { type: 'object',  additionalProperties: true },
    },
    required: ['query'],                              // query is the only thing it MUST give
    additionalProperties: false,
  },
};
```

```ts
// aptkit/packages/retrieval/src/search-knowledge-base-tool.ts:78-96
const handler: ToolHandler = async (args): Promise<SearchKnowledgeBaseOutput> => {
  const query = typeof args.query === 'string' ? args.query : '';
  const requestedTopK = typeof args.top_k === 'number' && args.top_k > 0 ? args.top_k : defaultTopK;
  const topK = Math.max(requestedTopK, minTopK);     // ← lines 80-81: the floor (see below)
  ...
  let hits = await pipeline.query(query, fetchK);    // the SAME pgvector lookup as AdvntrCue
  ...
  return { query, results: hits.map(toResult) };     // toResult builds [docId] snippet citations (108-118)
};
```

The retrieval mechanics inside `pipeline.query` — embed, HNSW cosine search, rank — are the
ones you already know from `study-ai-engineering`; this file does not re-teach them. The new
thing is the `minTopK` floor on line 81. buffr constructs the tool with `minTopK: 4`
(`session.ts:43`), so `topK = max(requested, 4)`. Why: a weak local model (gemma2:9b) will
sometimes pass `top_k: 1` and starve its own retrieval — one chunk can't answer a multi-part
question. The floor is a guardrail against the model under-asking. Hold that thought; it
reappears in file 02 as a *stand-in* for a relevance grader.

**Part 2 — The loop: the model decides whether and what to search.**

This is the inversion. The loop calls the model, sees whether the model emitted a tool call,
runs it if so, feeds the result back, and repeats — until the model answers in plain text or
the budget runs out.

```
  Part 2 diagram: the decision the model makes every turn

  turn N: model.complete(messages, tools)
     │
     ├─ response is text only ──────────────► finalText, break   (model chose to ANSWER)
     │
     └─ response has tool_use blocks
            │
            ▼
        for each: callTool() ──► push tool_result into messages   (model chose to SEARCH)
            │
            ▼
        loop to turn N+1   (model now sees its own results)
```

Bridge from known: this is your `fetch()` loading/error/success states, except the model is
the one deciding to re-fetch. Real code:

```ts
// aptkit/packages/runtime/src/run-agent-loop.ts:131-135
const toolUses = toolUsesFromContent(response.content);
if (toolUses.length === 0) {     // model emitted no tool call —
  finalText = text;              // it decided it can answer now.
  break;                         // exit the loop. (the "answer" branch)
}
// ...otherwise fall through, run each tool, push results, loop again (lines 137-190)
```

Nothing here *forces* a search. The model is nudged toward one by the system prompt — that
nudge lives in Part 3. The loop only provides the *opportunity* to search and the *plumbing*
to feed results back.

**Part 3 — The budget + the nudge: bounded freedom.**

The model is free to search 0 to N times — but "free" without a ceiling is an infinite loop
on a flaky local model. buffr bounds it: `maxTurns: 6`, `maxToolCalls: 4`. And it points the
freedom in the right direction with a system prompt that says "search first."

```
  Part 3 diagram: bounded freedom — the budget and the forced exit

  turn:   0     1     2     3     4     5
          │     │     │     │     │     │
  search: ✓     ✓     ✓     ✓     ✗     ✗     ← max 4 search calls (maxToolCalls:4)
                                  │     │
                                  └─────┴──► tools STRIPPED, synthesis FORCED
                                             (forceFinal → no tools, "answer now")
          └───────────── max 6 turns total (maxTurns:6) ──────────────┘
```

Bridge from known: a retry loop with a max-attempts counter and a "give up and return what
you have" branch. Real code, the budget check and the forced synthesis:

```ts
// aptkit/packages/runtime/src/run-agent-loop.ts:101-109
const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
const forceFinal = turn === maxTurns - 1 || budgetSpent;   // out of turns OR out of searches
const response = await model.complete({
  system: forceFinal && synthesisInstruction               // append "you have NO more tool calls"
    ? `${system}\n\n${synthesisInstruction}` : system,
  messages,
  tools: forceFinal ? undefined : toolSchemas,             // ← strip the tools: model CAN'T search now
  maxTokens, signal,
});
```

```ts
// aptkit/packages/agents/rag-query/src/rag-query-agent.ts:75-79
maxTurns: 6,
maxToolCalls: 4,
synthesisInstruction: buildSynthesisInstruction(          // run-agent-loop.ts:72-74
  'Now answer the question directly and concisely, citing the sources you retrieved.',
),
```

And the nudge — the system template that makes the model *want* to search before answering:

```ts
// aptkit/packages/agents/rag-query/src/rag-query-agent.ts:20-27
const DEFAULT_SYSTEM_TEMPLATE = [
  'You are a personal knowledge assistant.',
  '',
  `Always call the ${SEARCH_KNOWLEDGE_BASE_TOOL_NAME} tool first to retrieve relevant`,  // ← the "search first" nudge
  'passages before answering. Ground every answer in the retrieved chunks and cite',
  'their sources. If the knowledge base does not contain the answer, say so plainly',     // ← honesty over guessing
  'rather than guessing.',
].join('\n');
```

The wiring that assembles all three parts:

```ts
// buffr/src/session.ts:42-44, 57
const pipeline = createRetrievalPipeline({ embedder, store });        // 42: the retrieve path
const tool = createSearchKnowledgeBaseTool(pipeline, { minTopK: 4 }); // 43: wrap as a tool, floor at 4
const tools = new InMemoryToolRegistry([tool.definition], {           // 44: register it
  [tool.definition.name]: tool.handler,
});
// ...
const agent = new RagQueryAgent({ model, tools, profile, trace });    // 57: hand the loop its one tool
```

### Move 3 — the principle

**Agentic RAG is the model holding the retrieve step and choosing how many times to pull it,
inside a budget you set.** Static RAG asks "what do I retrieve once?" Agentic RAG asks "does
the model think it needs more, and can I afford to let it find out?" buffr answers: yes, up
to 4 times, then it must commit.

---

## Primary diagram (recap)

The whole pattern in one frame — static RAG on the left, buffr's agentic loop on the right.

```
  STATIC RAG vs AGENTIC RAG — the full picture

  STATIC RAG (AdvntrCue)              AGENTIC RAG (buffr)
  ════════════════════════           ═══════════════════════════════════════════
                                      system prompt: "search first, ground, cite,
   question                            say so plainly if not found"
      │                                      │
      ▼                                question ──► ┌─ runAgentLoop (≤6 turns) ──────┐
   embed + retrieve (once)                          │  model.complete()             │
      │                                             │    │                          │
      ▼                                             │    ├─ text only ──► ANSWER ◄───┤
   top-k chunks ──► prompt                          │    │                          │
      │                                             │    └─ search_knowledge_base    │
      ▼                                             │         (≤4 calls, minTopK 4)  │
   generate                                         │         │                      │
      │                                             │         ▼                      │
      ▼                                             │     pgvector top-k ──results──►─┤ loop
   answer                                           │  budget spent? strip tools,    │
                                                    │  FORCE synthesis ──► ANSWER     │
  engineer controls retrieval.                      └────────────────────────────────┘
  1 retrieve, fixed.                  model controls retrieval. 0..4 retrieves, bounded.
```

Same store, same embeddings, same HNSW lookup on both sides. The only thing that moved is
the controller of the retrieve step — and that one move is the entire concept.

---

## Elaborate

**The cost is real and buffr pays it on purpose.** Agentic RAG costs **3-10× the tokens**
and **2-5× the latency** of static RAG: every turn re-sends the growing message history
(question + all prior tool results) through the model, and each search is a full
model-roundtrip plus a vector query. Static RAG is one retrieve and one generate. buffr
accepts the multiplier because its job — a personal knowledge assistant answering
multi-part, cross-source questions ("what did I decide about X, and how does it relate to
Y?") — needs the model to gather evidence in more than one pass. For a single-fact lookup,
static RAG would be the right call and agentic RAG would be waste. Know which question
you're answering.

**buffr is the *simplest* agentic RAG, and that is a deliberate position.** It does NOT:
- **decompose sub-questions** — it does not break "compare A and B" into two planned
  retrievals; the model just freely issues search calls and the budget catches it.
- **re-retrieve on a grader signal** — there is no relevance grader between retrieval and
  generation deciding "these chunks are weak, search again." (That is file 02.)
- **route between sources** — there is exactly one source. (That is file 03.)

What buffr *is*: the model may call the one search tool 0 to 4 times, nudged by the prompt to
search first, then forced to answer. That is agentic RAG with nothing optional bolted on —
the honest floor of the pattern.

**Why "0..4" and not "always 1"?** The model *can* skip search entirely (the
`toolUses.length === 0` branch answers immediately). The prompt nudges against that, but a
nudge is not a guarantee on a 9B local model — which is exactly why file 02's grader pattern
exists, and exactly why buffr's `minTopK: 4` floor and "say so plainly" prompt are the
cheap insurance it ships instead.

---

## Interview defense

**Q: "Is buffr doing RAG or is it an agent? Pick one."**

> It's both, and the precise answer is the interesting one: buffr runs **agentic RAG, which
> is a ReAct loop whose primary — and only — tool is retrieval.** The model decides whether
> to search, writes the query, reads the chunks, and decides whether to search again, up to
> 4 calls across 6 turns, then it's forced to synthesize. Classic RAG retrieves once before
> the model ever runs; buffr's model holds the retrieve step. The framing I'd hand a
> skeptic: *all agentic RAG is agentic AI; not all agentic AI does retrieval.* buffr is the
> special case where the agent's tools are search tools — taken to its minimum, one search
> tool.

```
  The defense in one diagram

  agentic AI ⊃ agentic RAG ⊃ buffr
  ┌─────────────────────────────────────────────┐
  │ agentic AI: model loops over ANY tools       │
  │  ┌──────────────────────────────────────┐    │
  │  │ agentic RAG: the tools are SEARCH     │    │
  │  │  ┌─────────────────────────────────┐  │    │
  │  │  │ buffr: exactly ONE search tool, │  │    │
  │  │  │ 0..4 calls, then forced answer  │  │    │
  │  │  └─────────────────────────────────┘  │    │
  │  └──────────────────────────────────────┘    │
  └─────────────────────────────────────────────┘
```

**Anchor it in code if pushed:** the tool is `search-knowledge-base-tool.ts:43-99` (schema
53-76, handler 78-96, the `minTopK` floor 50-51 + 80-81). The loop that drives it is
`run-agent-loop.ts:76-202` — the search-or-answer decision at 131-135, the forced synthesis
at 101-109. The budget and the "search first" nudge are
`rag-query-agent.ts:75-79` and `20-27`. The wiring is `session.ts:42-44`.

---

## See also

- `02-self-corrective-rag.md` — the next rung: grade the chunks before trusting them, retry
  on a miss. buffr's `minTopK` floor and "say so plainly" prompt are its lightweight
  stand-ins.
- `03-retrieval-routing.md` — the other rung: pick the right *source*. buffr has one.
- `../01-reasoning-patterns/02-agent-loop-skeleton.md` — the ReAct kernel this pattern runs
  on; this file is that kernel with retrieval as the payload.
- `../01-reasoning-patterns/03-react.md` — the placement: buffr is plain ReAct, measured.
- **`study-ai-engineering`** — the retrieval mechanics underneath the tool: embeddings,
  chunking, HNSW, RRF, reranking, classic RAG vs GraphRAG. This file does not re-teach them.
