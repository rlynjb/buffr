# Chapter 3 — The Choices

This is the chapter interviewers spend the most time in, because it's where they find out
whether you *made* decisions or *defaulted into* them. Every load-bearing technology in buffr
gets one section here: the alternatives you weighed, the actual criterion you decided on, and
the cost you're paying. Not the trivial choices — nobody cares which test runner you picked.
The ones that shape the system.

There's a 2026 honesty layer running through this chapter. Some of these choices you made
deliberately. Some an AI tool suggested and you evaluated and accepted. A couple you defaulted
to — the library's defaults, never independently evaluated. The strongest answers name *which
mode* each decision was. The defaulted-to ones are the riskiest to own and the most
senior-positive when owned cleanly.

## The decision tree of the major choices

This is the chapter's spine: every load-bearing fork, with the option you picked highlighted.

```
  buffr's load-bearing choices — picked option in ★

  store the vectors?
    ├─ ★ pgvector in the same Postgres ★   ← operational simplicity
    ├─ Pinecone (hosted, $70/mo floor)
    └─ Weaviate / Qdrant (separate engine)

  run the model where?
    ├─ ★ local — Ollama on the laptop ★    ← own the stack, own the data, $0/query
    ├─ OpenAI / Anthropic hosted API
    └─ self-hosted GPU in cloud

  which local model?
    ├─ ★ gemma2:9b — no native tools ★      ← fits laptop RAM; accept emulated tool calls
    └─ a model WITH native tool-calling (heavier, or hosted)

  the relational store?
    ├─ ★ Postgres ★                         ← vectors + relational colocated, one instance
    └─ SQLite (no first-class pgvector)

  the toolkit boundary?
    ├─ ★ BUILD aptkit, consume as library ★ ← portfolio value, own the contracts
    └─ BUY: LangChain / LlamaIndex off the shelf

  the interface?
    ├─ ★ Ink / React-in-terminal ★          ← plays to my React strength, fast to build
    └─ a web UI (Next.js) / a raw readline CLI
```

Six forks. Walk them in order of how often they get probed: the vector store first (it always
comes up), then local-vs-hosted, then the build-vs-buy on aptkit (the one that shows the most
judgment).

## Choice 1 — pgvector, not a dedicated vector engine

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "Why pgvector and not Pinecone?"                              │
│                                                                 │
│ WHAT THEY'RE TESTING                                            │
│   Do you understand the cost of a network hop and a second      │
│   billing surface? Did you think about cost at YOUR scale, or   │
│   default to whatever you'd heard of? Can you compare on more   │
│   than one axis — not just "it's free"?                         │
└─────────────────────────────────────────────────────────────────┘
```

> "I picked pgvector for operational simplicity. The vectors live in the same Postgres instance
> as everything else — the documents, the conversation trajectories, the profile. That means
> the approximate-nearest-neighbour search and my relational data share one connection, one
> transaction boundary, one thing to back up, and zero network hops. A dedicated engine like
> Pinecone would add a separate service, a separate billing surface, and a round-trip over the
> network on every retrieval.
>
> This was a deliberate choice, and it's also the shape I'd already shipped in AdvntrCue — vector
> and relational colocated in one Postgres. The cost I'm paying: pgvector with HNSW is slower
> than a specialized engine once you're into hundreds of millions or billions of vectors. At my
> corpus size — low thousands of chunks — that gap is invisible; search is well under the model's
> generation time. If this grew to a scale where the vector count dwarfed everything else, I'd
> revisit it. It hasn't."

```
┌─────────────────────────┬─────────────────────────┐
│ WEAK ANSWER             │ STRONG ANSWER           │
├─────────────────────────┼─────────────────────────┤
│ "I used pgvector        │ "I picked pgvector for  │
│ because it's good for   │ operational simplicity. │
│ this kind of thing and  │ The vectors share one   │
│ I didn't want to pay    │ Postgres instance with  │
│ for Pinecone."          │ my relational data —    │
│                         │ no network hop, one     │
│                         │ backup, one transaction │
│                         │ boundary. The cost is    │
│                         │ pgvector's slower at     │
│                         │ billions of rows; not my │
│                         │ scale."                 │
├─────────────────────────┼─────────────────────────┤
│ Why it's weak:          │ Why it works:           │
│ "good for this kind of  │ One named criterion     │
│ thing" signals you      │ (operational            │
│ don't remember the      │ simplicity), a concrete │
│ reason. "Didn't want to │ mechanism (one          │
│ pay" is the only real   │ instance, no hop), and  │
│ axis — and it's the     │ the cost owned          │
│ shallow one.            │ explicitly with a scale │
│                         │ boundary.               │
└─────────────────────────┴─────────────────────────┘
```

```
"Why pgvector?"
      │
      ▼
You give the operational-simplicity answer.
      │
      ├─► IF THEY ASK ABOUT PERFORMANCE
      │     "pgvector is slower than specialized engines at billions
      │      of rows. At my data size it's well under generation
      │      latency, so it's never the bottleneck. The model is."
      │
      ├─► IF THEY ASK ABOUT THE INDEX
      │     "HNSW with the cosine opclass — vector_cosine_ops. The
      │      search orders by the <=> cosine-distance operator, and
      │      the index opclass matches it. If they DIDN'T match, you'd
      │      get a silent sequential scan — correct but slow. That
      │      alignment is the load-bearing correctness fact."
      │
      └─► IF THEY ASK ABOUT ALTERNATIVES
            "If I had to move off it I'd reach for Qdrant — I know its
             shape. But I'd only move when the vector count dwarfs the
             relational data, which it doesn't here."
```

> ┃ The strongest defense of a choice names the one criterion you
> ┃ decided on, then owns the cost with a scale boundary.

## Choice 2 — local models, not a hosted API

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "Why run the model locally instead of just calling OpenAI?"   │
│                                                                 │
│ WHAT THEY'RE TESTING                                            │
│   Do you have a real reason, or is "local" a buzzword? Hosted   │
│   models are smarter and easier — why give that up? Can you     │
│   name what you traded and why the trade was worth it for THIS  │
│   project?                                                       │
└─────────────────────────────────────────────────────────────────┘
```

> "Three reasons, in order. First, it's my own personal knowledge base — notes, a profile.
> Keeping it on-device means my data never leaves the laptop. Second, I wanted to own the whole
> stack end to end — the embedding model, the generation model, the vector store — because
> learning the seams was half the point of the project. Third, cost: zero marginal cost per
> query, which matters when you're iterating constantly.
>
> What I gave up is real and I'll name it: Gemma 2 9B is a meaningfully weaker model than a
> hosted frontier model, and — this is the big one — it has no native tool-calling. So I'm
> paying with model quality and with an emulated tool-call path that's the reliability ceiling
> of the system. For a personal, local-first agent where the data sensitivity and the learning
> goal dominate, that trade is worth it. If buffr were a product serving other people's
> questions, I'd flip to a hosted model in a heartbeat."

This is also where the local-first portfolio shows: dryrun runs Gemini Nano on-device with API
fallback, contrl runs MediaPipe with no cloud in the hot path. buffr is the third local-first
shape. You're not defending an unfamiliar pattern — it's a thread through your work.

```
╔═══════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                       ║
║                                                           ║
║   They ask: "What's the actual quality gap? Run me the    ║
║   numbers — how does gemma2:9b score against GPT-4 on     ║
║   your retrieval-grounded answers?"                       ║
║                                                           ║
║   You have NOT benchmarked Gemma against a hosted model.  ║
║   You score precision@k on retrieval, not answer quality  ║
║   head-to-head. Do not invent an eval you didn't run.     ║
║                                                           ║
║   Say:                                                    ║
║   "I haven't run that head-to-head. I score retrieval —   ║
║    precision@k and recall@k on a labeled query set — not  ║
║    a model-vs-model answer-quality benchmark. So I can    ║
║    tell you my retrieval is hitting the right chunks; I    ║
║    can't give you a calibrated Gemma-vs-GPT-4 number       ║
║    because I didn't measure it. What I CAN say is the     ║
║    failure I see most is the emulated tool call, not the  ║
║    model's reasoning once it has the right context."      ║
║                                                           ║
║   What this signals: you know exactly what your evals do  ║
║   and don't cover, and you won't manufacture a number.    ║
║                                                           ║
║   Do NOT say:                                             ║
║   "Gemma's probably about 80% as good." — a fabricated    ║
║   percentage on an eval you never ran collapses the       ║
║   moment they ask how you measured it.                    ║
╚═══════════════════════════════════════════════════════════╝
```

## Choice 3 — build aptkit, don't buy LangChain

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "Why build your own toolkit instead of using LangChain or     │
│    LlamaIndex?"                                                 │
│                                                                 │
│ WHAT THEY'RE TESTING                                            │
│   This is the build-vs-buy judgment probe. Building your own    │
│   framework is usually the WRONG call in production — they      │
│   want to see if you know that, and whether you have a reason   │
│   that survives it. "I wanted to learn" is fine IF you own it   │
│   as the reason rather than dressing it up.                    │
└─────────────────────────────────────────────────────────────────┘
```

> "I'll be straight about this one: I built aptkit deliberately, for portfolio value and to own
> the contracts. In a production setting with a deadline, reaching for LangChain or LlamaIndex is
> usually the right call — you don't build a framework to ship a feature. I built one because the
> goal of this project was to *understand* the seams of an AI system, and you understand them best
> by defining the ports yourself: the model-provider contract, the `VectorStore` port, the trace
> sink, the eval interface.
>
> What that bought me, concretely, is that buffr depends on *ports*, not implementations. My
> `PgVectorStore` is an adapter behind the `VectorStore` contract; the agent loop never knows
> it's talking to Postgres. I can swap the store, the model, the embedder without touching the
> agent. That's dependency inversion, and I got to feel why it matters by building both sides.
>
> The cost: I own the maintenance of a framework, and I don't get the ecosystem — the integrations,
> the community-tested edge cases — that LangChain has. For a personal project that's the right
> trade. For a team shipping a product, I'd buy."

That last sentence is the senior move. Naming when you'd make the *opposite* choice proves the
decision was reasoned, not reflexive.

## Choice 4 — the @aptkit/memory extraction

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "You said memory came from a separate package — why split     │
│    it out instead of just writing it inline in buffr?"          │
│                                                                 │
│ WHAT THEY'RE TESTING                                            │
│   Do you understand module boundaries and dependency            │
│   direction? Splitting a package out is easy to do badly. Can   │
│   you name what crosses the boundary, in which direction, and   │
│   why the split earns its keep?                                │
└─────────────────────────────────────────────────────────────────┘
```

> "The memory engine — embed a past exchange, tag it, recall it by relevance — is a reusable
> capability, not a buffr-specific one. So I extracted it *up* into aptkit as `@aptkit/memory`,
> and buffr consumes it. But here's the round-trip that makes it interesting: the engine needs a
> place to store vectors, and I didn't want it to know about Postgres. So the engine is built
> *up* into the library, and buffr injects its `PgVectorStore` *down* into the engine — the same
> adapter the retrieval pipeline uses.
>
> That's why memory rides the same chunks table. The engine embeds an exchange and upserts it
> through the injected store, tagged `kind=memory`, and future questions surface it through the
> exact same `search_knowledge_base` tool. There's no separate memory subsystem — episodic memory
> is just retrieval over rows I tagged differently. The boundary is: aptkit owns the *how* of
> remembering, buffr owns the *where* of storing."

```
"Why split memory into a package?"
      │
      ▼
You give the engine-up / store-injected-down answer.
      │
      ├─► IF THEY ASK "how does memory surface in a query?"
      │     "Through the same search tool. A memory row is a chunk
      │      tagged kind=memory. The ANN search doesn't care it's a
      │      memory — it ranks it by cosine similarity like any chunk."
      │
      ├─► IF THEY ASK "what if a memory write fails?"
      │     "Best-effort. session.ts wraps memory.remember in a
      │      try/catch that swallows — the turn already succeeded and
      │      the user has their answer. A memory failure must never
      │      lose the answer." (full defense: ch 5)
      │
      └─► IF THEY ASK "how do memory rows exist without a document?"
            "The dropped chunks→documents foreign key. A memory chunk
             has no documents row behind it. The FK would have rejected
             it. Dropping it enables this AND keeps drop-in parity with
             aptkit's in-memory store." (next choice)
```

## Choice 5 — the dropped chunks→documents foreign key

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "You dropped a foreign key on purpose? Walk me through that." │
│                                                                 │
│ WHAT THEY'RE TESTING                                            │
│   Dropping referential integrity is a red flag UNLESS you have  │
│   a real reason. They want to see if you understand what the    │
│   FK was protecting, what you traded for dropping it, and       │
│   whether you knew the cost — or just removed it to make an     │
│   error go away.                                                 │
└─────────────────────────────────────────────────────────────────┘
```

> "Yes, deliberately, and I'll give you both reasons because there are two. The first is
> drop-in parity. The `VectorStore` contract upserts chunks with no notion of a `documents` row
> — aptkit's in-memory store has no documents table at all. If my Postgres adapter enforced a
> hard foreign key from `chunks.document_id` to `documents.id`, it would reject any chunk that
> didn't have a matching document, and it would no longer be a drop-in implementation of the
> same contract. The adapter has to honor the port's behavior.
>
> The second reason fell out of the first, and it's the one I like more: dropping the FK is
> exactly what lets conversation memory ride the chunks table. A memory chunk has no document
> behind it — it's an embedded exchange, not a piece of an indexed file. With the FK in place,
> the memory write would fail. So the same decision that preserves contract parity also enables
> episodic memory on the same store.
>
> The cost I'm paying, and I won't dress it up: I've given up referential integrity. The database
> will not stop me from writing a chunk that points at a document that doesn't exist, and the
> two-transaction index write means a crash can orphan a document with no chunks — the engine
> won't complain. At single-operator scale I reconcile by re-indexing. The integrity guarantee
> now lives in my application code and my ids, not in the schema. That's a real trade, and it was
> the right one here."

```
┌─────────────────────────┬─────────────────────────┐
│ WEAK ANSWER             │ STRONG ANSWER           │
├─────────────────────────┼─────────────────────────┤
│ "The foreign key was    │ "I dropped it for two   │
│ causing errors when I   │ reasons: the VectorStore│
│ inserted chunks, so I   │ contract upserts chunks │
│ dropped it."            │ with no document        │
│                         │ notion, so the FK broke │
│                         │ drop-in parity; and     │
│                         │ dropping it is what lets │
│                         │ memory rows live on the │
│                         │ same table. The cost is │
│                         │ referential integrity,  │
│                         │ which I own."           │
├─────────────────────────┼─────────────────────────┤
│ Why it's weak:          │ Why it works:           │
│ "causing errors so I    │ Names what the FK       │
│ dropped it" is the      │ protected, the contract │
│ single worst way to     │ reason, the capability  │
│ explain dropping        │ it enabled, and the     │
│ integrity — it sounds   │ integrity cost          │
│ like you removed a      │ explicitly. A reasoned  │
│ guardrail to silence a  │ trade, not a silenced   │
│ symptom.                │ error.                  │
└─────────────────────────┴─────────────────────────┘
```

## Choice 6 — Ink, a terminal frontend

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "Why a terminal UI? Why Ink and not a web app?"               │
│                                                                 │
│ WHAT THEY'RE TESTING                                            │
│   A lower-stakes choice — but they want to see you can justify  │
│   a UI decision on cost and fit, not just preference. And for   │
│   a frontend-strong candidate, it's a chance to show you know   │
│   why React-in-terminal is still React.                        │
└─────────────────────────────────────────────────────────────────┘
```

> "Ink is React rendering to the terminal instead of the DOM — same component model, same hooks,
> same state. For a single-operator local tool, a terminal frontend is the fastest interface to
> build that still gives me a real component tree: `chat.tsx` holds the turns, the input, and the
> busy state in `useState`, exactly like a web chat would. I get a scrollback and a spinner without
> standing up a server, a browser, or a build for static assets.
>
> It also plays to my strength — seven years of frontend, mostly React — so the UI was never the
> hard part. The cost is that it's a terminal: no rich rendering, single-operator, not shareable
> over a network. For this phase that's exactly right. The web UI is a phone-phase concern, and
> when it comes, the component model carries straight over."

> ▸ React-in-terminal is still React. The component model
>   transfers; only the renderer changes.

## What you'd change about the choices

The one choice you'd reconsider isn't pgvector or local models — those still hold. It's the
unconfigured connection pool. `createPool` opens a `pg.Pool` with no `max`, no timeouts — it
takes the default of 10 connections. For one CLI user that's invisible, and it was never a real
decision; it was the default. The moment a second writer appears — the phone brain — pool sizing
becomes the first thing that matters. You'd name it now as a deliberately-deferred decision
rather than an unexamined default, which is the honest framing.

## One-page summary

**Core claim:** Every load-bearing choice in buffr has one named criterion, a real alternative
weighed, and a cost owned with a scale boundary. The strongest answers also name the
*decision mode* — deliberate, evaluated-and-accepted, or defaulted-to.

**The six choices defended:**
- **pgvector** over Pinecone → operational simplicity; one instance, no hop; cost is slowness at
  billions of rows (not my scale).
- **Local models** over hosted API → my data, owning the stack, $0/query; cost is model quality
  and the emulated tool call.
- **Build aptkit** over LangChain → portfolio + owning the contracts; cost is maintenance and no
  ecosystem; I'd buy on a team.
- **@aptkit/memory extraction** → reusable engine pushed up, store injected down; memory rides
  the same retrieval.
- **Dropped chunks→documents FK** → contract parity + enabling memory rows; cost is referential
  integrity, owned in app code.
- **Ink terminal UI** → fastest real-component interface, plays to React strength; cost is no
  rich/shareable UI.

**Pull quotes:**
- "The strongest defense of a choice names the one criterion you decided on, then owns the cost
  with a scale boundary."
- "React-in-terminal is still React. The component model transfers; only the renderer changes."

**What you'd change:** Configure the connection pool — `pg.Pool` runs on defaults (max 10, no
timeouts) today; name it as a deferred decision, not an unexamined default, since it's the first
thing that bites when a second writer arrives.
