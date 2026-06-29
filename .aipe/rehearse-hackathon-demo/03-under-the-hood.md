# Chapter 3 — Under the Hood   (6:00–8:00, 2 minutes)

## Opening hook

The room just watched buffr recall a past conversation. Now they want one
thing: *is that real, or is it a trick?* You get two minutes to earn
credibility — and you earn it with exactly one mechanism, drawn once,
explained in three sentences. Not an architecture tour. One non-obvious
design choice that makes the money shot work.

The choice is this: buffr stores past conversations in the *same* vector
store as your documents (retrieval store — `chunks` table), tagged as
memory. So recall isn't a separate memory system — it's the search tool the
agent already has, pointed at exchanges instead of docs. That's the whole
trick, and it's a genuinely clean one. Go exactly one level deep on it and
stop. Going two levels deep loses the room you just won.

## The time-budget bar

You own 6:00 to 8:00. Inside it: one diagram, three sentences, done. Resist
the urge to keep explaining.

```
  ┌──────────────────────────────────────────────────────┐
  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░ │
  │ 0:00 ──────── 6:00 ──── 8:00 ─────────────── 10:00    │
  │      UNDER THE HOOD — you own 6:00 to 8:00 (2 min)    │
  └──────────────────────────────────────────────────────┘
```

## The one diagram — memory rides the same store

Here is the single picture. Indexed documents and past exchanges live in one
`chunks` table; both are embeddings; one search tool retrieves from both. The
arrow that matters is the one labeled "same tool, same store."

```
  Why recall works — memory in the document store

  ┌─ A turn happens (npm run chat) ────────────────────────────────┐
  │                                                                 │
  │  you ask  ──►  RagQueryAgent  ──►  search_knowledge_base tool   │
  │                                          │ embed query (768-dim)│
  │                                          ▼                       │
  │             ┌─ Postgres + pgvector: chunks table ───────────┐   │
  │             │  one ANN search (HNSW, cosine) over BOTH:      │   │
  │             │                                                │   │
  │             │   • indexed docs   meta.kind = (doc)           │   │
  │             │   • PAST EXCHANGES meta.kind = 'memory'        │   │
  │             │                    id = "memory:<conv>:<n>"    │   │
  │             └────────────────────┬───────────────────────────┘   │
  │                                  │ top-k hits (docs OR memory)    │
  │                                  ▼                                 │
  │             Gemma answers, grounded in whatever ranked top        │
  │                                                                   │
  │  AFTER the turn:  memory.remember({question, answer})            │
  │     embeds THIS exchange → writes it back as kind='memory'       │
  │     ↑ so the NEXT session can retrieve it. The loop closes.      │
  └─────────────────────────────────────────────────────────────────┘
```

The thing to point at is that there is no separate "memory database." Past
exchanges are rows in the same `chunks` table as the documents, tagged
`kind='memory'`, retrieved by the same tool through one ANN search
(approximate nearest neighbor over the HNSW index). That's why a paraphrase
finds the old conversation: same embedding space, same retrieval, same tool.

## The three sentences — say exactly this, then stop

This is the whole explanation. Memorize these three lines. Do not add a
fourth.

```
  ┃ "When buffr answers, after each turn it embeds the exchange and
  ┃  writes it back into the SAME vector store as my documents —
  ┃  just tagged as memory."

  ┃ "So next time, a paraphrased question searches one store and the
  ┃  past conversation surfaces by meaning — same retrieval, same
  ┃  tool the agent already uses for docs."

  ┃ "That's the whole trick: memory is just retrieval, pointed at
  ┃  conversations instead of documents."
```

Three sentences, one diagram, two minutes. If a judge wants the depth —
the conversation-memory engine, the deterministic chunk ids, the dropped
foreign key that lets memory rows live without a documents row — that's the
Q&A and the study guides, not the demo. You go one level deep here and
hold.

## The credibility anchor — this is your shape

This pattern is not new to you, and saying so lands. You shipped classic RAG
before (AdvntrCue — pgvector + GPT-4 + session memory). buffr is the
local-first evolution of that same shape: the model moved on-device (Gemma
via Ollama), and the memory became retrieval-based episodic recall over your
own Postgres. One line, if it fits:

```
  ┃ "I've shipped RAG before in the cloud. buffr is the local-first
  ┃  version — the model runs on my laptop, and memory is just
  ┃  retrieval over my own database."
```

## Strong vs weak — the under-the-hood move

Two minutes is enough for exactly one idea. Spend it on the one that's
non-obvious, not on a layer-by-layer tour.

```
  WEAK under-the-hood                STRONG under-the-hood
  ──────────────────────────         ──────────────────────────────
  "let me walk the architecture:     ONE diagram: memory rides the
  UI, then session, then the         same store as docs. That's it.
  pipeline, then the store, then…"

  explain embeddings, HNSW,          three sentences. name HNSW once
  cosine distance, dimension         in passing, don't teach it.
  mismatch handling, the FK…

  six boxes, six arrows, the         one arrow that matters: "same
  room's eyes glaze                  tool, same store" — the insight

  go three levels deep, lose         go ONE level, hold, hand the
  the room you just won              depth to Q&A
```

## The IF-IT-BREAKS box

There's no live action here — it's a diagram and three sentences — so the
failure mode is verbal, not technical: you over-explain and run past 8:00,
eating your close.

```
  ╔══════════════════════════════════════════════════════════════╗
  ║ IF IT BREAKS (here, "breaks" = you run long)                 ║
  ║ You feel yourself going a fourth sentence deep → STOP at      ║
  ║ "memory is just retrieval pointed at conversations." Say:     ║
  ║ "happy to go deeper in Q&A" and move to the build story.      ║
  ║ The diagram alone, on screen, carries the credibility even    ║
  ║ if you say less. Protect the close — it's only 45 seconds.    ║
  ╚══════════════════════════════════════════════════════════════╝
```

## The "tighten it" treatment

Running long? Cut this chapter to the diagram plus the *third* sentence only
("memory is just retrieval, pointed at conversations instead of documents")
and skip the AdvntrCue anchor. **Floor: the room sees the one diagram and
hears the one-sentence why.** Below that, recall looks like magic instead of
engineering — and "it's just retrieval over the same store" is exactly the
line that makes a technical judge trust it.

## The one-page run sheet — Chapter 3

```
  ┌─ UNDER THE HOOD ──────────── 6:00–8:00 (2 min) ──────────────┐
  │                                                               │
  │  SHOW: the one diagram — memory rides the SAME chunks store   │
  │   as documents, tagged kind='memory', one ANN search.         │
  │                                                               │
  │  SAY (three sentences, then STOP):                            │
  │   1. "after each turn it embeds the exchange, writes it back  │
  │       into the same store as my docs — tagged as memory."     │
  │   2. "so a paraphrase searches one store and the past chat    │
  │       surfaces by meaning — same tool as docs."               │
  │   3. "memory is just retrieval, pointed at conversations."    │
  │                                                               │
  │  OPTIONAL anchor: "I shipped cloud RAG before; buffr is the   │
  │   local-first version."                                       │
  │                                                               │
  │  IF YOU RUN LONG: stop at sentence 3, "deeper in Q&A," move.  │
  │  TIGHTEN: diagram + sentence 3 only.                          │
  │   FLOOR: one diagram + one why.                               │
  └───────────────────────────────────────────────────────────────┘
```

Next: chapter 4 — proof it's real, and the hard part you cracked.
