# Chapter 03 — Under the Hood   (6:00–8:00, 2 minutes)

## Opening hook

The room just watched buffr remember a past conversation. Now they want to know how — and you have two minutes to earn credibility without losing them. The trap here is the architecture tour: pulling up six boxes and walking every arrow until the room's eyes glaze. Don't. Go exactly one level deep on the *one* thing that made the money shot possible, draw it as a single diagram, and explain it in about three sentences. One level deep, then stop. The goal isn't to teach the system — it's to prove you understand the system. Those are different, and the second one is shorter.

The single most impressive, non-obvious mechanism in buffr is this: **the memory is RAG over your chat history, and past exchanges live in the same vector store as your documents.** That's why recall works through the exact same search the documents use — no separate memory system, no special-casing. One store, two kinds of row, a tag to tell them apart. That is the whole trick, and it's genuinely elegant. Show that, and the room believes you built it.

## The time-budget bar

You own two minutes. One mechanism, one diagram, three sentences, then hand to the build story.

```
  ┌──────────────────────────────────────────────────────────┐
  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░ │
  │ 0:00              6:00 ─────── 8:00 ─────────────── 10:00 │
  │        UNDER THE HOOD — you own 6:00 to 8:00 (2 min)       │
  └──────────────────────────────────────────────────────────┘
```

## The chapter-opening diagram — memory is RAG, pointed at your chat

This is the one diagram you show. It says: writing a memory and retrieving a memory are the same two operations RAG already uses on documents — embed, then store or search. The corpus just happens to be your own past exchanges.

```
  EPISODIC MEMORY — RAG, but the corpus is your chat history

   AFTER a turn (write):                LATER, a new turn (read):
   "I use Neovim"  ─┐                   "configure my editor"
                    │ embed                       │ embed
                    ▼                             ▼
             ┌────────────┐                ┌────────────┐
             │  vector    │                │  vector    │
             └─────┬──────┘                └─────┬──────┘
                   │ upsert (tag kind=memory)    │ search top-k
                   ▼                             ▼
        ┌─────────── ONE shared vector store (agents.chunks) ─────────┐
        │  [doc] [doc] [memory:conv:0 "I use Neovim"] [doc] [memory…] │
        └──────────────────────────┬──────────────────────────────────┘
                                   │ the SAME search_knowledge_base tool
                                   ▼
                    past exchange surfaces alongside doc hits
                    → "it remembers me"  (what the room just saw)
```

The thing to point at: documents and memories are *in the same drawer*. That's the non-obvious choice, and it's why recall needed zero new retrieval code.

## The body — the mechanism in three sentences

You do not walk this slowly — this is a demo, not the study guide. Three sentences, each pointing at the diagram. Say them close to verbatim.

```
┃ "When buffr finishes answering, it embeds the whole exchange —
┃  question and answer — into the same vector store as my documents,
┃  tagged as a memory."
```

```
┃ "So a later question doesn't need a special memory system — the
┃  ordinary search retrieves the relevant past exchange the same way
┃  it retrieves a document chunk."
```

```
┃ "One store, two kinds of row, a tag to tell them apart. That's the
┃  whole trick — and because the memory engine only speaks the vector-
┃  store contract, I built it on my own toolkit and just handed it my
┃  Postgres."
```

That third sentence does double duty: it explains the mechanism *and* lands the "built on her own aptkit toolkit" architecture one-liner. The memory engine (`createConversationMemory` from `@aptkit/memory`) is store-agnostic — it knows nothing about Postgres — so buffr injects its `PgVectorStore` and gets episodic recall for free. That's the clean seam that lets the capability live in the toolkit and the storage live in the app.

## The one structural truth to name (if asked, not before)

If a judge presses on "is this just a chat log?", you have one crisp distinction ready. This is the load-bearing part people miss:

```
  CHAT LOG vs EPISODIC MEMORY — the distinction that matters

  ┌─ saved chat log ────────┐        ┌─ retrieval-based memory ────────┐
  │  rows in a messages     │        │  embeddings in a vector store   │
  │  table, ordered by time │        │  recalled by MEANING, top-k     │
  │  → scroll to find it     │        │  → relevant past exchange       │
  │  → exact match / time    │        │    surfaces for a PARAPHRASED   │
  │                          │        │    query it has never seen      │
  └──────────────────────────┘        └──────────────────────────────────┘
   buffr has BOTH: the messages table     ★ this is what made the demo
   is for observability (the trace);        work — recall by similarity,
   the vector memory is for recall.         not by keyword or timestamp
```

Both exist in buffr, and saying so is honest and precise: the `messages` table captures the full trajectory for observability; the vector memory is the thing that makes recall work for a question worded differently than the original. Don't volunteer this whole distinction in the two minutes — but have it loaded for the Q&A.

## Strong vs weak — under the hood

```
  WEAK UNDER-THE-HOOD                STRONG UNDER-THE-HOOD
  ─────────────────────────────      ─────────────────────────────────
  pulls up the full 5-layer          ONE diagram: memory = RAG over chat
  architecture diagram, walks         history, same store as docs
  every box, runs out of clock

  "so we have a retrieval pipeline    "one store, two kinds of row, a tag
   and a model provider and a          to tell them apart — that's the
   context guard and a trace sink…"    whole trick." (three sentences)

  → room sees complexity, not        → room sees ONE elegant idea and
     insight; loses the thread          believes you built it
```

## The IF-IT-BREAKS box

This chapter is a diagram and three sentences — there's no live app beat to crash. The failure mode is *you*, going too deep and running over.

```
╔══════════════════════════════════════════════════════════════════╗
║ IF IT BREAKS — you feel yourself going too deep / running long   ║
║                                                                   ║
║ You've started explaining embeddings, or HNSW, or the agent loop ║
║ → STOP at the current sentence. Say: "I'll spare you the rest —  ║
║ happy to go deeper in questions." Jump to Chapter 04. The depth   ║
║ is written in .aipe/study-ai-engineering/08 — you don't need it   ║
║ on the clock. One level deep, then out.                           ║
╚══════════════════════════════════════════════════════════════════╝
```

## The "tighten it" treatment

This chapter is already lean. If you're behind, collapse it to one sentence and the diagram on screen.

```
  TIGHTEN IT
    cut to:  show the diagram, say ONLY the third script line —
             "one store, two kinds of row, a tag to tell them apart;
              I built it on my own toolkit and handed it my Postgres."
    floor:   the room must hear that memory and documents share one
             retrieval path. That single idea is the credibility. Don't
             cut below it — without it the money shot looks like magic
             instead of engineering.
```

## The one-page run sheet — UNDER THE HOOD

```
  ┌─ RUN SHEET · 03 UNDER THE HOOD · 6:00–8:00 ────────────────────┐
  │                                                                 │
  │  GOAL: ONE diagram + three sentences. Prove you get it, then    │
  │        stop. One level deep, no architecture tour.              │
  │                                                                 │
  │  SHOW: the "memory = RAG over chat history, same store" diagram │
  │                                                                 │
  │  SAY (close to verbatim):                                       │
  │   1. "it embeds the whole exchange into the same store as my    │
  │       documents, tagged as a memory"                            │
  │   2. "so a later question retrieves the past exchange the same  │
  │       way it retrieves a document — no special memory system"   │
  │   3. "one store, two kinds of row, a tag to tell them apart —   │
  │       I built it on my own toolkit and handed it my Postgres"   │
  │                                                                 │
  │  IF YOU OVERRUN: stop mid-sentence, "happy to go deeper in Q&A" │
  │  TIGHTEN: diagram + sentence 3 only. Floor = "memory + docs     │
  │           share one retrieval path."                            │
  └─────────────────────────────────────────────────────────────────┘
```
