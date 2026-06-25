# Chapter 3 — The Choices

"Why this stack?" is where interviewers find out whether you make decisions or just accept defaults. The weak answer to every "why X" is "it's good for this kind of thing." The strong answer names the alternatives, names the actual criterion you decided on, and names the cost you're paying for the choice. Every real decision has a cost; pretending yours don't is the tell that you didn't really decide.

This chapter defends the eight load-bearing choices in `buffr-laptop`. Not the trivial ones — nobody cares which test runner you picked. The eight that an interviewer will actually probe, each with the alternatives, the criterion, and the cost. Some of these you decided deliberately. Some an AI tool suggested and you evaluated and accepted. One or two you defaulted to. The strong move is being honest about which is which, and this chapter marks each one.

```
  THE DECISION TREE — eight load-bearing choices

  Vector store?
   ├─ dedicated DB (Pinecone/Qdrant/Weaviate)
   └─ ★ pgvector in the same Postgres ★   ← colocation, one source of truth
         │
  ANN index?
   ├─ IVFFlat (needs training, batch)
   └─ ★ HNSW (no training, incremental) ★  ← index one doc, search now
         │
  Generation model?
   ├─ cloud LLM (GPT-4 / Claude)
   └─ ★ local gemma2:9b via Ollama ★      ← privacy + zero per-query cost
         │                                   (cost: no native tool-calling)
  Storage shape?
   ├─ separate vector + relational stores
   └─ ★ one Postgres, vectors + rows ★    ← one pool, one commit point
         │
  documents→chunks integrity?
   ├─ hard FK (rejects orphan chunks)
   └─ ★ soft link, FK dropped ★           ← parity + lets memory rows ride chunks
         │
  Embedding dimension?
   └─ ★ 768, committed everywhere ★       ← one-way door on indexed data
         │
  The agent loop itself?
   ├─ build it from scratch
   └─ ★ consume aptkit as a library ★     ← build the glue, not the loop
         │
  Conversation memory?
   ├─ build a bespoke memory store in buffr
   └─ ★ inject store into @aptkit/memory ★ ← engine up, store down; same contract
```

The starred path is what's in the repo. Every fork is a place the interviewer can stop and ask "why not the other branch?" — so let's defend each one.

## Choice 1 — pgvector, not a dedicated vector database

  ┌─────────────────────────────────────────────────────────┐
  │ THEY ASK                                                 │
  │   "Why pgvector and not Pinecone or Qdrant?"            │
  │                                                         │
  │ WHAT THEY'RE TESTING                                     │
  │   Do you understand the cost of a network hop and a      │
  │   second source of truth? Did you think about scale,    │
  │   or default to whatever you'd heard of? Can you         │
  │   compare on more than one axis?                        │
  └─────────────────────────────────────────────────────────┘

> "I picked pgvector for operational simplicity at my scale. There's exactly one client, one corpus, and my relational data — conversations, profiles, the source documents — lives in the same place. A dedicated vector DB would split my source of truth across two systems for no gain: I'd add a network hop, a second thing to operate, and a second billing surface, to solve a scaling problem I don't have. With pgvector, a chunk is one join from its document and I manage one connection pool. The cost I'm accepting is that pgvector is slower than specialized engines at billions of rows — but I'm nowhere near that, and the colocation is worth more to me than peak ANN throughput I'll never use."

Decision mode: **deliberate.** You shipped this exact shape before in AdvntrCue (pgvector + Drizzle + GPT-4). This is the local-first restatement of a pattern you already proved.

  ┃ "Colocate until you have a scaling axis that splits
  ┃  them. buffr never does."

```
  "Why pgvector?"
        │
        ▼  you give the operational-simplicity answer
        │
        ├─► IF THEY ASK ABOUT COST
        │     pgvector is free beyond the Postgres I already
        │     run. A managed vector DB starts a separate
        │     monthly bill. At one user that's pure overhead.
        │
        ├─► IF THEY ASK ABOUT PERFORMANCE AT SCALE
        │     pgvector is slower than specialized engines at
        │     billions of rows. At my corpus size it doesn't
        │     matter. Say so plainly — don't pretend it wins
        │     on raw throughput.
        │
        └─► IF THEY ASK "WHEN WOULD YOU SWITCH?"
              When vectors and relational data develop
              separate scaling axes — when one needs to scale
              independently of the other. Until then, splitting
              them is premature.
```

## Choice 2 — HNSW, not IVFFlat

  ┌─────────────────────────────────────────────────────────┐
  │ THEY ASK                                                 │
  │   "Why HNSW for the index and not IVFFlat?"             │
  │                                                         │
  │ WHAT THEY'RE TESTING                                     │
  │   Do you know there's more than one ANN method, and     │
  │   why one fits your write pattern? Or did you copy the   │
  │   first CREATE INDEX you found?                          │
  └─────────────────────────────────────────────────────────┘

> "HNSW because it has no training step and supports incremental inserts. I index documents one at a time, and I want to search immediately after — HNSW lets me do that. IVFFlat needs to see a representative sample of the data to build its centroids, so it's built for a batch-load-then-query pattern, not an incremental one. HNSW also degrades more gracefully on recall. The trade I'm accepting is that it's approximate by design — a greedy graph walk can miss the true top-k — and the recall-vs-latency knob, `ef_search`, I left at the default. I haven't tuned it because I don't have a recall baseline to tune against yet; that's a known gap."

Decision mode: **evaluated and accepted.** You knew both methods existed and picked on the write pattern. The honest part is the untuned `ef_search` — own it.

The one line that wins this answer: the opclass-operator pairing. The index is built with `vector_cosine_ops` and queried with `<=>`. If those don't match — if someone queries with the L2 operator `<->` against a cosine index — Postgres silently ignores the index and does a full sequential scan. No error. Just orders of magnitude slower as the corpus grows. Knowing that one line is the single most load-bearing thing in the storage layer signals you understand the index, not just that you typed it.

  ┃ "The operator and the opclass are a matched pair.
  ┃  Mismatch them and you scan the whole table with
  ┃  no error to tell you."

## Choice 3 — local Gemma via Ollama, not a cloud LLM

  ┌─────────────────────────────────────────────────────────┐
  │ THEY ASK                                                 │
  │   "Why a local model instead of GPT-4 or Claude?         │
  │    Wouldn't a frontier model just be better?"           │
  │                                                         │
  │ WHAT THEY'RE TESTING                                     │
  │   Did you choose local for a reason, or because it was   │
  │   free? Do you understand what you GAVE UP — and what    │
  │   that forced you to engineer around?                    │
  └─────────────────────────────────────────────────────────┘

> "Local was the whole point of the project, not a cost-saving fallback. It's my own notes — a personal knowledge base — so keeping everything on the laptop is the privacy story, and there's zero per-query cost so I can iterate freely. But I'm honest that I gave up answer quality: gemma2:9b is weaker than a frontier model, and more interestingly, it has no native tool-calling. That forced the most interesting engineering in the system — the toolkit emulates tool-calling by rendering the tool schema into the prompt and parsing the JSON back out. A cloud model would have given me that for free. Choosing local meant I had to understand and rely on that emulation layer, which is exactly the kind of thing I wanted to learn."

Decision mode: **deliberate** — local-first is your through-line across dryrun (Gemini Nano) and contrl (MediaPipe). You've shipped on-device AI three times; this is consistent, not a fluke.

The frontier-model gap is real and you name it. But you turn the limitation into the interesting part: it's *because* Gemma can't call tools natively that you ended up understanding emulation, which most candidates who used GPT-4's tool API have never had to think about. Chapter 6 goes deep on this; here, just establish that local was a choice with a known cost.

## Choice 4 — one Postgres for both vectors and relational data

  ┌─────────────────────────────────────────────────────────┐
  │ THEY ASK                                                 │
  │   "Vectors and your application data in one database —   │
  │    isn't that mixing concerns?"                         │
  │                                                         │
  │ WHAT THEY'RE TESTING                                     │
  │   Do you know when separation buys you something and     │
  │   when it's just ceremony? Can you defend colocation     │
  │   without sounding lazy?                                │
  └─────────────────────────────────────────────────────────┘

> "It's one process, one pool, one commit point. Durability is Postgres's promise at COMMIT, not something my code has to coordinate across two systems. Separating concerns buys you something when the two halves scale independently or fail independently — but here they don't. A chunk and its source document and the conversation that retrieved it all live one join apart. Splitting them would mean coordinating writes across two stores and reasoning about partial failure, to separate things that have no reason to live apart at this scale. I'd separate them the day vectors need to scale on a different axis than the relational data. That day hasn't come."

Decision mode: **deliberate.** This is the same instinct as Choice 1 — colocate until there's a scaling axis to split on.

## Choice 5 — the deliberately-dropped foreign key

This is the one that looks like a bug and isn't. Interviewers love finding it, because it lets them test whether you'll defend a decision or apologize for a mistake.

  ┌─────────────────────────────────────────────────────────┐
  │ THEY ASK                                                 │
  │   "Your chunks have a document_id but no foreign key     │
  │    to documents. Isn't that a missing constraint —       │
  │    a bug?"                                              │
  │                                                         │
  │ WHAT THEY'RE TESTING                                     │
  │   Will you cave and call it a bug, or do you know        │
  │   exactly why it's there? Do you understand the          │
  │   contract that forced it? Can you name what you gave    │
  │   up and how you'd get it back if you needed it?        │
  └─────────────────────────────────────────────────────────┘

> "That's deliberate, and the schema comments say why. My pgvector store implements aptkit's VectorStore contract, and that contract upserts chunks with no notion of a documents row — it's just `id`, `vector`, `meta`. A hard foreign key would reject any chunk written before its parent document existed, which would break drop-in parity with the in-memory store the contract is built around. The FK and the contract are mutually exclusive, and I chose the contract — the migration even actively drops the constraint if a previous version of the schema had it. What I gave up is the database enforcing parent-exists and cascade-delete; integrity relocated to my application's call order, where `indexDocumentRow` writes the document first, then the chunks. And here's where the decision pays off twice: when I added conversation memory, the memory rows ride the same `chunks` table tagged `meta.kind='memory'` — and they have *no* parent document at all. A hard FK would have rejected every one of them. The dropped constraint is exactly what lets a second kind of vector (an embedded exchange) share the table with corpus chunks. If I needed integrity back, the fix isn't re-adding the FK — that re-breaks both parity and memory — it's wrapping the index writes in one transaction plus an orphan-sweep keyed on document_id, scoped to corpus chunks only."

Decision mode: **deliberate** — and a strong one to volunteer. Notice the proof it's principled, not lazy: the schema *keeps* a real foreign key elsewhere — `messages.conversation_id` references `conversations` with cascade delete — because the trace sink writes through your own code with no external contract forbidding it. The presence or absence of the FK marks exactly where an external contract crosses the boundary. That's the answer that turns a "gotcha" into a signal of depth.

  ┃ "I enforce integrity in the database unless an
  ┃  external contract forbids it. chunks: the contract
  ┃  forbids it, so it's dropped. messages: nothing
  ┃  forbids it, so it's kept."

## Choice 6 — the embedding dimension is a one-way door

  ┌─────────────────────────────────────────────────────────┐
  │ THEY ASK                                                 │
  │   "Why hard-code 768 everywhere? Why not make the        │
  │    dimension configurable?"                             │
  │                                                         │
  │ WHAT THEY'RE TESTING                                     │
  │   Do you understand that the embedding dimension isn't   │
  │   a runtime knob — it's a commitment baked into every    │
  │   indexed row? Do you fail loud on a mismatch, or        │
  │   would you silently corrupt retrieval?                 │
  └─────────────────────────────────────────────────────────┘

> "768 is the dimension of nomic-embed-text, my embedder, and it's a one-way door on indexed data. Query and corpus vectors have to share a space to be comparable — so switching embedders changes the dimension, which invalidates the entire indexed corpus. I'd have to re-embed every document and migrate the `vector(768)` column. It's cheap to set and expensive to undo, so I treat it as a commitment and source the number from one place: the embedder reports its dimension, the pipeline asserts the embedder and store agree at wiring time, and the store asserts every vector's length before any read or write. Critically, that assertion *throws* — it never truncates or pads — because a silently-truncated vector would index fine and then retrieve wrong forever. Fail loud at wiring time, never degrade at query time."

Decision mode: **deliberate** — and the defense-in-depth here was called out in the study guides as better than most production RAG systems. The killer detail is that `assertDim` throws rather than coerces. A lot of systems would pad or truncate to "be helpful," and that turns a loud wiring bug into a silent retrieval-quality bug you'd never catch.

## Choice 7 — consuming aptkit as a library, not building the loop

This one is about honesty as much as architecture. The agent loop, the tool emulation, the eval scorers — those live in `@rlynjb/aptkit-core`, which you consume and never edit. An AI helped you assemble a lot of it.

  ┌─────────────────────────────────────────────────────────┐
  │ THEY ASK                                                 │
  │   "Did you write the agent loop, or is that the          │
  │    library?"                                            │
  │                                                         │
  │ WHAT THEY'RE TESTING                                     │
  │   Will you overclaim? Do you know precisely where your   │
  │   code ends and the library begins? Can you defend the   │
  │   decision to NOT build the loop?                        │
  └─────────────────────────────────────────────────────────┘

> "The loop is the library — I consume aptkit and never edit it. That was a deliberate scope decision: reinventing the agent loop and vector search would have cost me the time and hidden the interesting parts. What I built is the glue and the judgment layer — the pgvector store implementing the library's VectorStore contract, the Postgres persistence, the Ink chat REPL and the long-lived chat session, the index and eval CLIs, the trajectory trace sink, the memory wiring (injecting my store into aptkit's engine), and choices like flooring the tool's result count so a model asking for one chunk still gets four. I can point at the exact seam: imports and interface implementations cross the npm boundary; everything below `src/` is mine. If there were a bug in the loop, the fix goes upstream into aptkit, not a node_modules edit."

Decision mode: **deliberate.** The senior move is the precision of the seam. You're not claiming the loop. You're claiming the integration, and you can draw the exact line. That precision is worth more than pretending you wrote everything.

  ┃ "I don't claim what I wired. I claim the integration,
  ┃  and I can draw the exact line where my code ends."

## Choice 8 — conversation memory as an injected capability

This one is new, and it's the cleanest demonstration of the seam discipline from Choice 7 — because the memory capability was literally *extracted out of buffr and up into the library*, then re-consumed.

  ┌─────────────────────────────────────────────────────────┐
  │ THEY ASK                                                 │
  │   "How does it remember anything? Did you build the      │
  │    memory system?"                                      │
  │                                                         │
  │ WHAT THEY'RE TESTING                                     │
  │   Do you understand what kind of memory this is — and    │
  │   the difference between persisting a chat log and       │
  │   making past turns retrievable? Do you know where the   │
  │   engine ends and your store begins?                    │
  └─────────────────────────────────────────────────────────┘

> "It's retrieval-based episodic memory — RAG applied to conversation history instead of documents. After each turn, the question and answer get embedded and written back into the same vector store, tagged `meta.kind='memory'`, so a later turn — even in a future session — can pull a relevant past exchange back by similarity, through the exact same `search_knowledge_base` tool that retrieves corpus chunks. The important honesty: I didn't build the memory *engine* — `createConversationMemory` is aptkit's, in the published `@aptkit/memory` package. What I did was draw the seam. The engine speaks only the `EmbeddingProvider` and `VectorStore` contracts, so I inject my `PgVectorStore` and it has no idea it's talking to Postgres. The interesting history is that this engine was extracted *up* out of buffr into aptkit and then re-consumed here — a clean round-trip across the npm boundary. That's the proof the contract holds: the same capability can move out of my app and into the toolkit without my persistence layer changing a line. The cost I'm accepting is that this is relevance-based recall, not sequential in-prompt turn history — each `answer()` still treats its question independently; I get memory by similarity, not a running transcript in the prompt."

Decision mode: **deliberate** on the seam, **evaluated-and-accepted** on the engine. You chose to inject a store into a library capability rather than hand-roll a memory table, and you can name exactly what that buys (store-agnostic engine, testable against the in-memory store) and what it costs (no sequential history). For a 7-year frontend engineer, the move that lands here is the contract-as-seam reasoning — the same instinct as a well-designed React boundary, where the consumer injects state and the component stays ignorant of where it came from.

  ┃ "The memory engine moved up into the library and came
  ┃  back down — and my persistence layer never changed.
  ┃  That round-trip is the contract proving itself."

## A note on the Ink chat surface — a genuine frontend

Worth naming when the conversation touches the interface: the chat REPL is built in **Ink — React in the terminal**. `chat.tsx` is a real React component tree (`useState` for the turn list and the busy flag, `TextInput` and `Spinner` from the Ink ecosystem, the same render/state/effect model as a browser app). That's not incidental for you — it's a terminal *frontend surface*, and it plays directly to seven years of React. When an interviewer asks "what did you build," the chat UI is a place where your existing strength and this new AI-engineering work meet: same mental model (declarative components, state-driven render), different runtime. Claim it as the part of the system you were *most* equipped to build, not the least.

## Strong vs. weak — defending any choice

  ┌──────────────────────────────┬──────────────────────────────┐
  │ WEAK DEFENSE                 │ STRONG DEFENSE               │
  ├──────────────────────────────┼──────────────────────────────┤
  │ "I used pgvector because     │ "I picked pgvector for       │
  │ it's good for this kind of   │ operational simplicity. One  │
  │ thing and a lot of people    │ corpus, one client, and my   │
  │ use it."                     │ relational data lives in the │
  │                              │ same instance — so I avoid   │
  │                              │ a network hop and a second   │
  │                              │ source of truth. The cost is │
  │                              │ it's slower at billions of   │
  │                              │ rows, which I'm nowhere near."│
  ├──────────────────────────────┼──────────────────────────────┤
  │ Why it's weak:               │ Why it works:                │
  │ "Good for this kind of       │ Names the criterion          │
  │ thing" is filler — it        │ (operational simplicity),    │
  │ signals you don't remember   │ the specific tradeoff        │
  │ why you chose it. "A lot of  │ (network hop, second store), │
  │ people use it" is an appeal  │ and the cost you're paying   │
  │ to popularity, not a         │ (throughput you don't need). │
  │ reason.                      │ Three axes, one decision.    │
  └──────────────────────────────┴──────────────────────────────┘

The structure is always the same: criterion, tradeoff, cost. If your defense of any choice doesn't have all three, it's the weak version dressed up.

## When you don't know

The choice you're least equipped to defend deeply is the embedding model *quality* — whether nomic-embed-text is actually the right embedder, versus the alternatives, on retrieval benchmarks. You picked it because it's local and 768-dim and it worked; you didn't benchmark it against, say, a larger local embedder.

  ╔═══════════════════════════════════════════════════════════╗
  ║ WHEN YOU DON'T KNOW                                       ║
  ║                                                          ║
  ║   They ask: "How does nomic-embed-text compare to other  ║
  ║   embedding models on retrieval quality? Why this one?"  ║
  ║                                                          ║
  ║   Say:                                                   ║
  ║   "I chose it on operational fit — it's local, it's      ║
  ║    768-dim, and it ran well through Ollama. I haven't    ║
  ║    benchmarked it head-to-head against other embedders   ║
  ║    on a retrieval set, so I can't give you a quality     ║
  ║    ranking. What I'd do to answer that properly: my eval ║
  ║    harness already scores precision and recall against   ║
  ║    a labeled query set, so I'd swap the embedder,        ║
  ║    re-index, and compare the numbers. That's the         ║
  ║    measurement I haven't run yet."                       ║
  ║                                                          ║
  ║   What this signals: you chose on a real (if narrow)     ║
  ║   criterion, you don't pretend to a benchmark you didn't ║
  ║   run, and you know exactly the experiment that would    ║
  ║   settle it. That last part is what makes it senior.     ║
  ║                                                          ║
  ║   Do NOT say:                                            ║
  ║   "It's one of the best embedding models, I'm pretty     ║
  ║    sure it's near the top of the leaderboards."          ║
  ║   You'll get asked "which leaderboard, what score" and   ║
  ║   the bluff collapses.                                   ║
  ╚═══════════════════════════════════════════════════════════╝

## What you'd change

The choice you'd most reconsider is leaving `ef_search` at its default. It's the highest-leverage tuning knob in the whole retrieval path — it directly trades recall for latency — and you have a recall harness that could sweep it, but you never wired the two together. You'd build an exact-scan baseline (force Postgres to skip the index, get ground-truth nearest neighbors), then sweep `ef_search` against your eval set to find the recall floor you're actually getting. Right now a recall regression from an under-tuned index would be invisible. That's the choice you defaulted to rather than decided — and the senior move is owning that it was a default, not dressing it up as deliberate.

## One-page summary

**Core claim:** Every choice defense has three parts — the criterion, the tradeoff, the cost. Missing any one is the weak version.

**The eight choices, one line each:**
- *pgvector vs dedicated DB* → operational simplicity, one source of truth; cost: throughput at billions of rows I don't have. (deliberate)
- *HNSW vs IVFFlat* → no training, incremental insert; cost: approximate, `ef_search` untuned. (evaluated)
- *local Gemma vs cloud* → privacy + zero per-query cost; cost: weaker model, no native tool-calling. (deliberate)
- *one Postgres* → one pool, one commit point; split when scaling axes diverge. (deliberate)
- *dropped FK* → preserves VectorStore parity AND lets memory rows ride chunks; cost: integrity moves to call order. (deliberate)
- *768 committed* → one-way door, fail loud, never truncate. (deliberate)
- *consume aptkit* → build the glue, not the loop; I can draw the exact seam. (deliberate)
- *injected memory* → inject store into `@aptkit/memory`; engine-up/store-down; cost: relevance recall, not sequential history. (deliberate seam, evaluated engine)

**Pull quotes:**
- "Colocate until you have a scaling axis that splits them."
- "The operator and the opclass are a matched pair. Mismatch them and you scan the whole table with no error."
- "I don't claim what I wired. I claim the integration."

**What you'd change:** Wire the recall harness to sweep `ef_search` — the highest-leverage knob I defaulted on instead of deciding.

---

Updated: 2026-06-24 — added an eighth choice (conversation memory injected into `@aptkit/memory` — the engine-up/store-down round-trip) and an Ink/React chat-surface note that plays to the reader's frontend strength; strengthened the dropped-FK defense to show it now also enables parent-less memory rows to ride the `chunks` table.
