# Chapter 3 — The Choices

This is the longest chapter, and it's the one that wins or loses senior
interviews. "Why did you pick X?" is the question that separates someone
who made decisions from someone who accepted defaults. The answer to
every one of these is the same shape: name the alternatives, name the
real decision criterion, name the cost you're paying. Not "X is good for
this" — that's the filler that tells an interviewer you don't remember
why you chose it.

There are eight load-bearing choices in buffr worth defending. The
trivial ones — which test runner, which env loader — don't get a section,
because no interviewer cares and pretending they were agonized decisions
wastes the room. These eight carry real weight.

## The choices — the decision tree

Every box here is a fork you took with a reason. The picked branch is
marked. This is the chapter's map.

```
  buffr's load-bearing choices — picked branch marked ★

  build it / buy a tool? ──────────► ★ BUILD (portfolio: own the
                                        interesting parts) · not Hermes

  vector store? ───────────────────► ★ pgvector in ONE Postgres
                                        (colocate vector + relational)
                                        · not Pinecone, not Weaviate

  where do models run? ────────────► ★ LOCAL via Ollama (gemma2:9b +
                                        nomic-embed) · not GPT-4/cloud
                                        cost: Gemma = reliability ceiling

  agent logic: in-app or library? ─► ★ aptkit LIBRARY (contracts up,
                                        impls down) · memory extract-up
                                        round-trip · not inline

  chunks→documents FK? ────────────► ★ DROP it (soft link) · preserves
                                        VectorStore parity + lets memory
                                        rows exist · not a hard FK

  interface? ──────────────────────► ★ Ink/React terminal TUI
                                        (plays to React strength) · not
                                        a web UI, not one-shot CLI

  Gemma tool calls? ───────────────► ★ EMULATE (schema in prompt, parse
                                        JSON back) · Gemma has no native
                                        tool API · the reliability ceiling

  eval quality? ───────────────────► ★ precision@k / recall@k WIRED ·
                                        faithfulness (RubricJudge) NOT
                                        wired yet · named, not hidden
```

Now defend each one.

---

### Choice 1 — Build it, instead of using Hermes

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "Why build this yourself instead of using an existing agent  │
│    framework?"                                                  │
│                                                                 │
│ WHAT THEY'RE TESTING                                           │
│   Do you know what NOT to build? A senior engineer who builds  │
│   everything from scratch is a red flag. They want to hear     │
│   that you drew the line deliberately — built the parts that   │
│   signal skill, reused the parts that don't.                   │
└─────────────────────────────────────────────────────────────────┘
```

The strong answer:

> "It's a portfolio project, so the goal isn't shipping fastest — it's
> demonstrating the engineering that a turnkey tool hides. Hermes Agent,
> for example, is a multi-agent Python platform running fine-tuned models
> — if I'd used it, I'd be showing I can configure a platform, not that I
> can write a model provider, a RAG pipeline, and an eval harness. So I
> built the *judgment layer* — the Gemma provider, the retrieval ranking,
> the trajectory capture, the evals — and I deliberately did NOT reinvent
> the agent loop or vector search, because those cost scope and hide the
> interesting parts. I borrowed exactly one idea from Hermes: capture
> every conversation as a trajectory now, so fine-tuning is *answerable*
> later instead of assumed. The cost of building it myself is that it's
> less feature-complete than a platform — single agent, single device. I
> traded breadth for owning the parts that matter."

This is the answer that signals seniority because it draws the line in
*both* directions: built the interesting parts (`agent-layer-plan.md:23-35`),
reused the boring parts (vector search, the loop), borrowed one
discipline (trajectory capture). Building everything is junior. Building
nothing is junior. Knowing which is which is senior.

```
  ┃ Building everything is a red flag. So is building nothing.
  ┃ The senior signal is naming exactly where you drew the line.
```

#### The follow-up tree

```
  You give the build-the-judgment-layer answer.
        │
        ├─► IF THEY ASK "what did you borrow from Hermes specifically?"
        │     → The trajectory-capture discipline ONLY — not the
        │       multi-agent platform, not the fine-tuned models. buffr
        │       runs stock Gemma 2. Capture now, so fine-tuning is
        │       evidence-driven later (agent-layer-plan.md:17).
        │
        ├─► IF THEY ASK "isn't reinventing the agent loop the fun part?"
        │     → I DID write the loop — it's in aptkit (run-agent-loop,
        │       bounded maxTurns/maxToolCalls). What I didn't reinvent
        │       is pgvector and the embedding math. I build glue and
        │       judgment, not substrate.
        │
        └─► IF THEY ASK "would you use a framework for the real thing?"
              → For a product with a deadline, yes — LangChain or
                similar. For a portfolio piece whose whole point is to
                show the engineering, no. Different goals, different call.
```

---

### Choice 2 — pgvector in one Postgres, not a dedicated vector DB

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "Why pgvector and not Pinecone or Weaviate?"                 │
│                                                                 │
│ WHAT THEY'RE TESTING                                           │
│   Do you understand the cost of a network hop and a second     │
│   system? Did you think about your actual scale, or default    │
│   to whatever vector DB you'd heard of? Can you compare on     │
│   more than one axis?                                           │
└─────────────────────────────────────────────────────────────────┘
```

The strong answer:

> "Operational simplicity and colocation. My vector data and my
> relational data — the documents, the conversation history, the
> trajectory — all live in one Postgres instance, so a single
> transaction and a single connection cover both. When I index a
> document, the documents row and the chunk embeddings commit together
> in one transaction; I don't have a two-system consistency problem
> between a relational store and a separate vector store. A dedicated
> vector DB like Pinecone adds a network hop, a second billing surface,
> and a second thing to keep in sync — and at my data scale, hundreds to
> low-thousands of chunks, I get nothing for that. It's the same call I
> made in AdvntrCue: colocate the vector and relational data in one
> Postgres. The cost I'm watching: pgvector with default HNSW params
> degrades on recall and build time past roughly 10k chunks. At that
> point I'd tune the index, not switch databases."

This answer compares on *three* axes — operational (one system),
consistency (one transaction), cost (no second billing surface) — and
names the scale ceiling where the calculus flips. That's what "can you
compare on more than one axis" is looking for.

#### Weak vs strong — pgvector

```
┌─────────────────────────────┬─────────────────────────────┐
│ WEAK ANSWER                 │ STRONG ANSWER               │
├─────────────────────────────┼─────────────────────────────┤
│ "I used pgvector because    │ "Operational simplicity     │
│ it's good for RAG and I      │ and colocation. Vector and  │
│ already knew Postgres."     │ relational data are in one  │
│                             │ Postgres, so one            │
│                             │ transaction covers an index │
│                             │ write. Pinecone adds a      │
│                             │ network hop and a second    │
│                             │ system to sync, and at my   │
│                             │ scale I gain nothing. Cost: │
│                             │ default HNSW degrades past  │
│                             │ ~10k chunks — then I tune,  │
│                             │ not switch."                │
├─────────────────────────────┼─────────────────────────────┤
│ Why it's weak:              │ Why it works:               │
│ "Good for RAG" is filler.   │ Names the criterion         │
│ "I already knew Postgres"   │ (colocation), the specific  │
│ is the real reason but it   │ tradeoff avoided (network   │
│ sounds like laziness        │ hop + sync), the scale at   │
│ unstated. No alternative    │ which it flips, and the     │
│ evaluated, no cost named.   │ next move at that scale.    │
│                             │ Familiarity becomes a       │
│                             │ deliberate "fewer moving    │
│                             │ parts," not laziness.       │
└─────────────────────────────┴─────────────────────────────┘
```

---

### Choice 3 — Local models via Ollama, not a cloud API

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "Why run Gemma locally instead of just calling GPT-4? You'd  │
│    get better quality."                                         │
│                                                                 │
│ WHAT THEY'RE TESTING                                           │
│   Did you weigh quality against the things local buys you, or  │
│   did you pick local for ideology? Can you name what you GAVE  │
│   UP by going local — because that's the honest part most      │
│   candidates skip?                                              │
└─────────────────────────────────────────────────────────────────┘
```

The strong answer:

> "Three reasons, and a real cost. One, privacy — it's a *personal*
> agent over my own documents and conversation history, and I didn't
> want that leaving my machine. Two, cost — zero dollars per call, the
> only ledger is latency and my 8k-token input budget. Three, it's a
> portfolio piece I wanted to own end-to-end, including writing the model
> provider against a messy local model. Now the honest cost: gemma2:9b is
> the reliability ceiling of the whole system. It has no native tool-call
> API, so I emulate tool calls — I render the tool schema into the system
> prompt and parse the JSON back out. That parse is the dominant failure
> mode: the model emits the wrong arg key, the search runs empty, and the
> answer comes back ungrounded. GPT-4 with native tool-calling would
> mostly remove that failure mode. So I traded answer quality and tool
> reliability for privacy, cost, and ownership. For this project's goals,
> that's the right trade — for a production product where reliability is
> the product, I'd reconsider."

That answer is strong *because* it volunteers the cost — the Gemma
reliability ceiling — instead of pretending local was free. The
interviewer asked "what did you give up," and you answered it before
they had to push.

```
  ┃ Local models bought me privacy, cost, and ownership. The
  ┃ price was the Gemma reliability ceiling — emulated tool
  ┃ calls that miss. I name the price; I don't pretend it's free.
```

---

### Choice 4 — The aptkit library boundary (and the memory extract-up)

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "Why split this into a library plus an app? Why not just one │
│    codebase?"                                                   │
│                                                                 │
│ WHAT THEY'RE TESTING                                           │
│   Do you understand dependency inversion in practice, not just │
│   as a SOLID acronym? Can you point at a concrete payoff the   │
│   boundary bought you — or is it separation for its own sake?  │
└─────────────────────────────────────────────────────────────────┘
```

The strong answer:

> "Because aptkit is meant to be reused across apps, and buffr is one
> running body with a database and secrets. If I welded Postgres and
> Ollama config into the toolkit, that kills its reuse. So the contracts
> and logic — the vector store interface, the agent loop, the memory
> engine — live in aptkit; the implementations and deployment live in
> buffr. The dependency arrow always points at aptkit; buffr imports it
> and can't edit it. The concrete payoff: when I graduated the store from
> in-memory to pgvector, the agent loop and retrieval pipeline changed
> zero lines, because they only ever spoke the `VectorStore` interface.
> And the cleverest part is a round-trip — the conversation-memory engine
> was *born in buffr*, turned out to be general, so I extracted it up into
> aptkit and now re-consume it. It only worked because that engine never
> names a database; it takes a `VectorStore` as a parameter. buffr injects
> its `PgVectorStore` down for durable memory; a test injects an in-memory
> store for the same logic. The cost of the two-repo boundary is friction —
> a change that spans both is two PRs — but that friction is the feature:
> it's what stops buffr from special-casing Postgres inside the pipeline
> and rotting the contract."

The memory extract-up round-trip (`src/session.ts:53`,
`.aipe/project/context.md:24`) is your single best architecture story.
It's dependency inversion you can *narrate as an event* — code moved
across the boundary and cost nothing because it always spoke the
contract. Lead with it when this thread opens.

#### The follow-up tree

```
  You give the dependency-inversion answer.
        │
        ├─► IF THEY ASK "what stops the boundary from rotting?"
        │     → The hard published-package line. buffr CAN'T edit
        │       aptkit, so it must conform to the contract or extract
        │       a new one up. The friction is the feature.
        │
        ├─► IF THEY ASK "give me the concrete payoff"
        │     → In-memory → pgvector swap: zero agent-loop changes.
        │       The contract is the unit of evolution. Same move
        │       absorbs the deferred Edge-Function store later.
        │
        └─► IF THEY ASK "isn't two repos overkill for one developer?"
              → For shipping speed, maybe. For keeping the contract
                honest under co-evolution, the hard boundary earns it.
                I'd revisit if the round-trips got expensive.
```

---

### Choice 5 — Dropping the chunks→documents foreign key

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "Your chunks reference a document_id but there's no foreign  │
│    key. Isn't that a missing integrity constraint?"            │
│                                                                 │
│ WHAT THEY'RE TESTING                                           │
│   Did you drop the FK on purpose or forget it? This is a trap  │
│   that looks like a bug. They want to see if you can defend a  │
│   relaxed integrity constraint as a deliberate tradeoff —      │
│   the senior answer — or whether you'll flinch and call it     │
│   tech debt.                                                    │
└─────────────────────────────────────────────────────────────────┘
```

The strong answer:

> "Deliberate, for two reasons. First, the `VectorStore` contract upserts
> chunks with no notion of a documents row — it just stores
> `{id, vector, meta}`. A hard FK would add a hidden precondition: a
> documents row must exist before any chunk. That breaks drop-in parity
> with the in-memory store, which has no documents concept at all.
> Second — and this is the one that actually forces it — conversation
> memory rides the same `chunks` table, tagged `kind=memory`, and memory
> rows have *no documents row* by nature. They're exchanges, not source
> files. A hard FK would reject every memory write. So `document_id` is a
> soft link, no constraint. The cost I accept: nothing in the database
> stops an orphaned chunk. I'm trading referential integrity for contract
> parity and the ability to let two kinds of rows share one table and one
> HNSW index. It's documented in the schema comment and the design spec
> — it's a tradeoff, not an oversight."

The whole game on this question is *not flinching*. The interviewer is
probing whether you'll defend the relaxed constraint or apologize for
it. You defend it — `sql/001_agents_schema.sql:18-27`, two named reasons,
one named cost.

```
  ┃ A relaxed constraint defended as a deliberate tradeoff is
  ┃ a senior signal. The same constraint called "tech debt"
  ┃ in an apologetic voice is a junior one. Same FK, opposite
  ┃ read.
```

---

### Choice 6 — An Ink/React terminal TUI

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "Why a terminal UI in React? Why not a web app, or just a    │
│    plain CLI?"                                                   │
│                                                                 │
│ WHAT THEY'RE TESTING                                           │
│   Is the interface choice incidental or reasoned? For a        │
│   frontend engineer pivoting to AI, do you understand that     │
│   Ink is React — the same component model, state, and          │
│   reactivity — just rendered to a terminal?                    │
└─────────────────────────────────────────────────────────────────┘
```

The strong answer:

> "Ink is React rendered to the terminal — same component model, same
> `useState`, same render-on-state-change. So `chat.tsx` is a React
> component: it holds the turn list, the input, and a busy flag as state,
> and re-renders as the conversation grows. That plays directly to my
> strength — seven years of React — while keeping the whole thing in one
> Node process with no browser, no bundler, no server. A web UI would
> have meant a frontend *and* an API layer, which the design called YAGNI
> for a single-device tool. A plain CLI would've meant one-shot
> question-answer with no held conversation; I needed a long-lived
> session that keeps one conversation in-process across turns. Ink gives
> me the reactive UI model I know, at terminal weight. The cost: it's a
> personal tool's interface, not something I'd ship to non-technical
> users — but that's the right scope for the phase."

This is a choice you can own with total confidence because it's *your*
domain. Lead into it by naming that Ink is React (`src/cli/chat.tsx:1-13`
— `useState`, the component, the busy spinner). For a frontend engineer
pivoting to AI, this is the answer where you're unambiguously on home
ground.

---

### Choice 7 — Emulating Gemma tool calls

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "How does the model call the search tool? Walk me through    │
│    the tool-calling."                                           │
│                                                                 │
│ WHAT THEY'RE TESTING                                           │
│   Do you understand what tool-calling actually IS underneath   │
│   the API sugar? Gemma has no native tool API — do you know    │
│   that, and do you know what you built to work around it?      │
└─────────────────────────────────────────────────────────────────┘
```

The strong answer:

> "Gemma 2 has no native tool-call API — there's no `tools` parameter
> like GPT-4 or Claude have. So I emulate it. The tool schema gets
> rendered into the system prompt as instructions: 'to search, emit JSON
> shaped like this.' The model produces free text, and I scan it for a
> JSON object and parse out the tool name and arguments. If it parses, I
> run the search and feed the results back; if not, the model answers
> directly. The honest weakness: there's no argument-schema validation. If
> the model emits the wrong key — say `q` instead of `query` — it passes
> straight through and the handler coerces the missing `query` to an empty
> string, so the search runs empty and the answer comes back ungrounded.
> That's the single dominant failure mode of the system, and it's the
> reliability ceiling of choosing a local model with no native tools. I
> know exactly what would fix it — native-tool-calling model, or strict
> arg validation on the parse — and I know exactly why I haven't: the
> whole point was to run local."

This answer is gold for an AI-engineering interview because it shows you
understand that "tool-calling" is a *capability* some models have
natively and others have to emulate — and you built the emulation and
measured its failure mode. Naming the empty-query coercion as the
dominant failure is the detail that proves you ran it, not just read
about it.

```
  ┃ "Tool-calling" isn't magic — it's schema-in-the-prompt and
  ┃ parse-the-JSON-back when the model has no native API. I
  ┃ built that, and the parse miss is my reliability ceiling.
```

---

### Choice 8 — precision@k evals wired, faithfulness not

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "How do you know your RAG is any good? How do you evaluate    │
│    it?"                                                          │
│                                                                 │
│ WHAT THEY'RE TESTING                                           │
│   Do you measure, or do you vibe-check? And — the sharper       │
│   probe — do you know the DIFFERENCE between measuring          │
│   retrieval and measuring answer faithfulness? Most candidates  │
│   conflate them.                                                 │
└─────────────────────────────────────────────────────────────────┘
```

The strong answer:

> "I have an offline eval that scores *retrieval* — precision@1 and
> recall@3 over a labeled query set in `eval/queries.json`. For each
> query I know the relevant docs, I run the pipeline, and I score whether
> the right docs came back in the top-k. That's wired and runnable as
> `npm run eval`. But I want to be precise about what it does NOT measure:
> it scores retrieval, not *faithfulness*. A hallucinated answer over
> perfect chunks scores nothing here, because I never score the answer —
> only the retrieved docs. The faithfulness eval is the gap. aptkit ships
> a `RubricJudge` that could grade the answer against the chunks, but I
> haven't wired it into buffr yet. So my honest position is: I measure
> the retrieval half of RAG quality, I know the generation half is
> unmeasured, and closing that gap with the RubricJudge is the next eval
> I'd build."

The strong move here is naming the *seam* between retrieval-quality and
answer-faithfulness, and being honest that you only measure one side.
That distinction — most candidates say "I have evals" and mean one
number — is what marks you as someone who's thought about LLM evaluation
properly.

#### Weak vs strong — evals

```
┌─────────────────────────────┬─────────────────────────────┐
│ WEAK ANSWER                 │ STRONG ANSWER               │
├─────────────────────────────┼─────────────────────────────┤
│ "I have evals — I test it   │ "I score retrieval with     │
│ with a set of queries and   │ precision@1 and recall@3    │
│ check the answers are       │ over a labeled set. But     │
│ good."                      │ that measures RETRIEVAL,    │
│                             │ not faithfulness — a        │
│                             │ hallucination over good     │
│                             │ chunks scores nothing,      │
│                             │ because I never grade the   │
│                             │ answer. The faithfulness    │
│                             │ eval (a RubricJudge) is the │
│                             │ gap, and it's my next       │
│                             │ build."                     │
├─────────────────────────────┼─────────────────────────────┤
│ Why it's weak:              │ Why it works:               │
│ "Check the answers are      │ Names exactly what's        │
│ good" is a vibe-check       │ measured (retrieval), what  │
│ disguised as a metric.      │ isn't (faithfulness), why   │
│ Conflates retrieval and     │ they're different, and the  │
│ generation. Sounds like     │ specific next step. Honesty │
│ "evals" as a buzzword, not  │ about the gap reads as more │
│ a measurement.              │ rigorous, not less.         │
└─────────────────────────────┴─────────────────────────────┘
```

---

### Where you'll get pushed past your depth

```
╔═══════════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                           ║
║                                                               ║
║   On the pgvector choice, the deep push is HNSW internals:    ║
║   "How does HNSW actually build the graph? What's the         ║
║   ef_construction parameter doing?" You chose HNSW on         ║
║   pgvector defaults and the recall numbers held up — you      ║
║   haven't read the graph-construction paper.                  ║
║                                                               ║
║   Say:                                                        ║
║   "I haven't gone deep into HNSW's graph-construction         ║
║    internals — I picked it on pgvector's operational          ║
║    defaults and my retrieval numbers held up on the eval      ║
║    set. I know the shape: it's a navigable small-world graph  ║
║    you descend layer by layer to approximate nearest          ║
║    neighbors, and m / ef_construction trade index build       ║
║    time and memory against recall. Past that, I'd be reciting ║
║    a paper I haven't read carefully. If you want to dig into  ║
║    the parameter tuning, walk me through what you're after."  ║
║                                                               ║
║   What this signals: you know the SHAPE (small-world graph,   ║
║   the recall/build tradeoff) and the operational knob, you    ║
║   own that you took the default, and you don't fake the       ║
║   internals. Knowing the shape but not the paper is exactly   ║
║   the right depth for someone who USED it well.               ║
║                                                               ║
║   Do NOT say:                                                 ║
║   "It builds a hierarchical graph and... uh... uses cosine    ║
║    distance to find close vectors fast" — mushing together    ║
║    half-remembered terms. Better to cleanly own the           ║
║    default than to fog the internals.                         ║
╚═══════════════════════════════════════════════════════════════╝
```

This is the "defaulted-to" mode being owned well: you didn't deeply
evaluate HNSW's internals, you took pgvector's default, and the right
move is to say *exactly that* — confidently — not to dress it up.

---

### What you'd change about the choices

The choice I'd most reconsider is the eval gap. The whole portfolio
thesis behind buffr is "measure, don't vibe-check" — and I shipped the
retrieval eval but left faithfulness unwired, which means the
generation half of the system is unmeasured. If I were re-prioritizing
today, I'd wire the `RubricJudge` before adding any new feature, because
an unmeasured generation path undercuts the project's own argument.
Everything else I'd keep: pgvector, local models, the library boundary,
the dropped FK are all calls I'd make again at this scale.

---

## One-page summary — Chapter 3

**Core claim:** Every choice gets the same shape — alternatives,
criterion, cost. "Good for this" is filler. Eight choices carry real
weight.

**The eight, one line each:**

- **Build vs Hermes** — build the judgment layer (provider, RAG, evals),
  reuse the loop + vector search, borrow trajectory-capture discipline.
- **pgvector / one Postgres** — colocation: one transaction covers vector
  + relational. Cost: default HNSW degrades past ~10k chunks.
- **Local models** — privacy + cost + ownership. Cost: Gemma is the
  reliability ceiling (emulated tool calls miss).
- **aptkit boundary** — dependency inversion; payoff is zero-agent-change
  store swap; the memory extract-up round-trip is the star.
- **Dropped FK** — preserves `VectorStore` parity + lets memory rows live
  in `chunks`. Cost: no DB-level orphan protection. Deliberate.
- **Ink/React TUI** — Ink is React; plays to frontend strength, no
  browser/server. Cost: technical-user interface only.
- **Gemma tool emulation** — schema-in-prompt, parse JSON back; no arg
  validation → empty-query coercion is the dominant failure.
- **Evals** — precision@k/recall@k wired; faithfulness (RubricJudge)
  not wired. The retrieval/generation eval seam, named honestly.

**Pull quotes:**

```
  ┃ Building everything is a red flag. So is building nothing.

  ┃ A relaxed constraint defended as a deliberate tradeoff is
  ┃ senior; the same one called "tech debt" apologetically is
  ┃ junior.

  ┃ "Tool-calling" isn't magic — it's schema-in-prompt and
  ┃ parse-JSON-back when the model has no native API.
```

**The "I don't know":** HNSW internals — own the default, name the shape
(small-world graph, recall/build tradeoff), don't fake the paper.

**What you'd change:** Wire the faithfulness eval (RubricJudge) before
any new feature — the unmeasured generation path undercuts the "measure,
don't vibe-check" thesis.
