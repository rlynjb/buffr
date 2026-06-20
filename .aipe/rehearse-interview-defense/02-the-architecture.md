# Chapter 2 — The Architecture

After the pitch, someone stands up and says "walk me through the architecture." This is the whiteboard moment, and it's where a lot of candidates fall apart — not because they don't understand their system, but because they try to *talk* it instead of *draw* it. The rule for this chapter: draw first, talk while you draw, and have the diagram fully in your head so you can reproduce it from scratch in ninety seconds without hesitating.

`buffr-laptop` has two flows worth drawing: the index path (how a document becomes searchable) and the query path (how a question becomes an answer). They share the storage and the models. If you can draw those two flows and name what crosses each boundary, you've defended the architecture. This chapter teaches you to draw them and tells you exactly where the interviewer will interrupt.

```
  buffr — the architecture, both flows on one board

  ┌─ CLI ──────────────────────────────────────────────────────┐
  │  index-cmd            ask-cmd                               │
  │  (a .md file)         (a question string)                  │
  └──────┬──────────────────────┬──────────────────────────────┘
         │ INDEX PATH            │ QUERY PATH
         ▼                       ▼
  ┌─ aptkit-core (library) ─────────────────────────────────────┐
  │                                                            │
  │  RetrievalPipeline         RagQueryAgent (bounded loop)    │
  │   .index(doc)               ├─ inject profile into prompt  │
  │     ├ chunk text            ├─ model.complete()            │
  │     ├ embed all chunks ─┐   ├─ wants tool? → search ──┐    │
  │     └ store.upsert()    │   ├─ ≤4 tool calls, ≤6 turns │    │
  │                         │   └─ forced final synthesis  │    │
  └─────────────────────────┼───────────────────────────────┼───┘
         │ embed             │ embed query        │ generate │
         ▼                   ▼                   ▼          │
  ┌─ Ollama (localhost:11434) ─────────────────────────────────┐
  │  nomic-embed-text:v1.5 → vector(768)   gemma2:9b → text     │
  └─────────────────────────┬───────────────────────────────────┘
         │ INSERT chunks      │ SELECT … ORDER BY embedding <=> q
         ▼                   ▼
  ┌─ Postgres + pgvector (reindb / schema agents) ─────────────┐
  │  documents ──soft link── chunks(vector(768), HNSW cosine)  │
  │  conversations ─FK→ messages(trajectory)   profiles        │
  └─────────────────────────────────────────────────────────────┘
```

That's the whole system. The index path goes top-left down; the query path goes top-right down and the answer comes back up. Everything below the CLI is either the library you consume or infrastructure you run.

## The big question: walk me through the system

  ┌─────────────────────────────────────────────────────────┐
  │ THEY ASK                                                 │
  │   "Walk me through what happens when you ask a           │
  │    question."                                            │
  │                                                         │
  │ WHAT THEY'RE TESTING                                     │
  │   Do you actually understand the data flow, or do you    │
  │   only know the parts you typed? Can you name what       │
  │   crosses each boundary — what's a vector, what's a      │
  │   SQL row, what's a model call? Do you know where the    │
  │   control flips from your code to the model?            │
  └─────────────────────────────────────────────────────────┘

Draw the query path as you say this, in your voice:

> "When I run `ask` with a question, the CLI wires up the pieces — a Postgres pool, the local embedder, my pgvector store, the retrieval pipeline — and constructs the agent. Before anything else it loads my profile from the database, a `me.md`-style document, and injects it at the front of the system prompt so the model knows who 'the author' is.
>
> Then it hands the question to the agent loop. The agent decides whether to search. When it wants to, it calls the one tool it has — `search_knowledge_base` — which embeds the question into the same 768-dimension space as the corpus and runs a cosine nearest-neighbor query against pgvector's HNSW index. That comes back as the top chunks with their source ids, and the agent reads them.
>
> The loop is bounded: at most four tool calls and six turns. On the final turn the loop physically removes the tools and tells the model it has none left, so it must stop searching and synthesize an answer from what it retrieved. The answer comes back, I persist the whole trajectory — every turn — into Postgres, and print the answer. Nothing in that path leaves the laptop."

Then, if they want the index path, draw the left side:

> "Indexing is simpler. `index` reads a markdown file, writes it whole into a `documents` table as the source of truth, then the pipeline chunks it, embeds all the chunks in one call to the local model, and upserts each chunk as a row keyed `docId#index`. The deterministic id is what makes re-indexing idempotent — index the same file twice and you overwrite the same rows instead of duplicating them."

  ┃ "The control flips at the loop boundary: my code
  ┃  decides the budget, the model decides the steps
  ┃  inside it. That's what makes it an agent, not a
  ┃  pipeline."

That last line is the one that signals depth. Anyone can describe a retrieve-then-generate flow. Knowing exactly *where* your code stops deciding and the model starts — and that you re-take control with a hard budget — is the thing an interviewer remembers.

## The load-bearing part people forget

When you walk the loop, name the termination guarantee. It's the part everyone leaves out, and naming it is the strongest signal you built the thing rather than read about it.

The naive version of an agent loop is "let the model call tools until it's done." The problem: a weak model can keep wanting to search forever, hit the budget, and produce *no answer at all*. The fix in this system is the forced synthesis turn — on the last allowed turn the loop sets the tools to undefined and appends an instruction telling the model it has no tools left and must answer now. Taking the tools away is the teeth; just asking nicely isn't enough, because a model with tools available will reach for one.

  ┌─────────────────────────────────────────────────────────┐
  │ THEY ASK                                                 │
  │   "What stops the agent from looping forever?"           │
  │                                                         │
  │ WHAT THEY'RE TESTING                                     │
  │   Do you know your control loop has a termination        │
  │   guarantee, or did you assume the model would just      │
  │   stop on its own? This is the question that separates   │
  │   "I wired up an agent" from "I understand agent         │
  │   control flow."                                         │
  └─────────────────────────────────────────────────────────┘

Your answer:

> "Two independent caps plus a forced exit. The loop is bounded to six turns and four tool calls — asymmetric on purpose, so there's always at least one turn left to synthesize after the search budget is spent. And on the final turn the loop removes the tool schemas entirely and tells the model it has none left. The caps alone aren't enough; you have to take the tools away, or the model emits one last tool call you can't service. That termination logic is in the library, but it's the mechanic I'd point to as the most important one in the whole flow."

## Where they'll interrupt — and what to say

Whiteboard walks get interrupted. Here's the map.

```
  You're drawing the query path.
        │
        ├─► THEY INTERRUPT: "How does it find chunks
        │   with no keyword match?"
        │     → Semantic search. The question is embedded
        │       into the same 768-dim space as the corpus;
        │       I rank by cosine distance with pgvector's
        │       <=> operator over an HNSW index. Paraphrases
        │       match without shared words. (Ch 6 goes deep.)
        │
        ├─► THEY INTERRUPT: "Why is the vector store its
        │   own class? Why not query Postgres directly?"
        │     → It implements aptkit's VectorStore contract,
        │       so the agent has no idea it's Postgres. Same
        │       contract passes against the in-memory store
        │       and mine. Swap the body, agent untouched.
        │
        ├─► THEY INTERRUPT: "Where's the second user?"
        │     → There isn't one. Single-device, single
        │       operator. Every table has app_id and every
        │       query filters on it, so the multi-tenant
        │       SHAPE is there, but there's no RLS yet —
        │       deliberately deferred. (Ch 3 + Ch 7.)
        │
        └─► THEY INTERRUPT: "What's the soft link between
            documents and chunks?"
              → The FK was deliberately dropped. The
                VectorStore contract upserts chunks with no
                notion of a documents row, so a hard FK
                would break drop-in parity. Looks like a
                bug; it's a contract decision. (Ch 6.)
```

Every one of those is a question you welcome, because each one lets you show a decision rather than recite a feature.

## Strong vs. weak — the architecture walk

  ┌──────────────────────────────┬──────────────────────────────┐
  │ WEAK WALK                    │ STRONG WALK                  │
  ├──────────────────────────────┼──────────────────────────────┤
  │ "So the user asks a          │ [draws the boundaries first] │
  │ question and the agent       │ "Question comes in here at    │
  │ figures out the answer       │ the CLI. It embeds into the  │
  │ using the LLM and the        │ same 768-dim space as the    │
  │ vector database and returns  │ corpus, searches pgvector by │
  │ it."                         │ cosine distance, the model   │
  │                              │ reads the chunks, and the    │
  │                              │ loop forces a final answer    │
  │ [no diagram, all prose]      │ within a four-call budget."   │
  ├──────────────────────────────┼──────────────────────────────┤
  │ Why it's weak:               │ Why it works:                │
  │ "Figures out the answer" is  │ Names what crosses each      │
  │ a black box. No boundaries,  │ boundary (a vector, a SQL    │
  │ no diagram, no idea what     │ query, a model call). Draws  │
  │ data is in what form. The    │ before talking. Names the    │
  │ interviewer learns nothing   │ budget and the forced exit   │
  │ about whether you            │ — proof you understand the   │
  │ understand the flow.         │ control flow.                │
  └──────────────────────────────┴──────────────────────────────┘

The weak walk treats the system as one box labeled "magic." The strong walk treats it as labeled boundaries with named data crossing each one. Interviewers grade the second; the first reads as someone who used a tutorial.

## When you don't know

The whiteboard is where you're most likely to get pushed into HNSW internals — the actual graph-walk mechanics of the index you rely on. You picked it on defaults; you don't know the algorithm cold. That's fine, if you say it right.

  ╔═══════════════════════════════════════════════════════════╗
  ║ WHEN YOU DON'T KNOW                                       ║
  ║                                                          ║
  ║   They point at the HNSW index and ask: "How does HNSW   ║
  ║   actually traverse the graph to find neighbors?"        ║
  ║                                                          ║
  ║   Say:                                                   ║
  ║   "I haven't gone deep into the graph-walk internals.    ║
  ║    What I know: it's a navigable small-world graph, so   ║
  ║    it's approximate — a greedy walk that can miss the    ║
  ║    true top-k, and the recall-vs-latency knob is         ║
  ║    ef_search, which I left at the default. I chose HNSW  ║
  ║    over IVFFlat because it needs no training step and    ║
  ║    supports incremental inserts, which fits indexing one ║
  ║    doc at a time. If you want to walk the layer descent, ║
  ║    can you start me off?"                                ║
  ║                                                          ║
  ║   What this signals: you know the SHAPE (approximate,    ║
  ║   tunable via ef_search), you know WHY you picked it     ║
  ║   (no training, incremental insert), and you don't fake  ║
  ║   the internals. You also invite them to teach, which    ║
  ║   reads as a learner, not a bluffer.                     ║
  ║                                                          ║
  ║   Do NOT say:                                            ║
  ║   "It's a graph thing where it finds nodes that are      ║
  ║    kind of close to each other somehow."                 ║
  ║   Vague hand-waving in territory you don't own is the    ║
  ║   surest way to fail a senior screen.                    ║
  ╚═══════════════════════════════════════════════════════════╝

## What you'd change

If you were drawing this architecture fresh today, the one structural thing you'd change is the index path's atomicity. Right now `indexDocumentRow` writes the `documents` row in one implicit transaction, then the chunk upsert runs in a separate one — so a crash between them leaves a document with no chunks. It's tolerable because the corpus is re-derivable (just re-run `index`) and the write path is single-writer, but if you were drawing the ideal version you'd thread one pinned connection through both writes so a document and its chunks commit together. It's a one-parameter fix you'd make before this ever became a service. Naming it unprompted is the move.

## One-page summary

**Core claim:** Draw before you talk. Name what crosses every boundary. Know exactly where control flips from your code to the model.

**The questions, with one-line answers:**
- *"Walk me through a question."* → Load profile into prompt → agent decides to search → embed query → cosine NN over HNSW → read chunks → forced synthesis within a 4-call budget → answer → persist trajectory.
- *"What stops it looping forever?"* → 6 turns, 4 tool calls, and a forced final turn that removes the tools entirely.
- *"How does it match with no keywords?"* → Semantic: query embedded into the same 768-dim space, ranked by cosine `<=>` over HNSW.
- *"Why is the store its own class?"* → It implements aptkit's VectorStore contract; the agent never knows it's Postgres.

**Pull quotes:**
- "The control flips at the loop boundary: my code decides the budget, the model decides the steps inside it."
- "Taking the tools away is the teeth; just asking nicely isn't enough."

**What you'd change:** Make the index path atomic — thread one transaction through the document write and the chunk upsert so they commit together.
