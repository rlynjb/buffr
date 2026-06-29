# Chapter 03 — Under the hood   (6:00–8:00, 2 minutes)

## Opening hook

The room just watched it remember a prior conversation. Now they're wondering whether it's real or smoke. This chapter earns the credibility — but you go exactly one level deep and stop. Two minutes, one diagram, three sentences of mechanism. Not an architecture tour. If you start explaining the embedding model, the HNSW index parameters, and the Ollama provider all at once, you lose the room and you blow past 8:00. Pick the single most impressive, least obvious thing and show only that.

The one thing worth showing: **memory and your documents live in the same table, served by the same vector index, recalled through the same tool.** That's why the recall in the demo wasn't a special "memory feature" bolted on the side — it's your existing retrieval, pointed at the conversation's own history. When a judge hears that, they understand the money shot was architecture, not a hack. That's the credibility beat.

## The time-budget bar

You own 6:00 to 8:00. One diagram, the one non-obvious mechanism, then hand off — do not overstay.

```
  ┌──────────────────────────────────────────────────────┐
  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░ │
  │ 6:00 ──────── 8:00 ──────────────────────────────── 10:00 │
  │       UNDER THE HOOD — you own 6:00 to 8:00 (2 min)   │
  └──────────────────────────────────────────────────────┘
```

## The chapter-opening diagram — one store, two roles

This is the only diagram you show in this chapter, and you point at it while you talk. It's the master demo diagram zoomed into the one part that matters: the shared store.

```
  WHY IT REMEMBERS — one store, one index, one tool

  ┌─ Session layer (src/session.ts) ──────────────────────────────┐
  │  every turn:  agent.answer(q)                                  │
  │               then  memory.remember({ conv, question, answer })│  ← writes the
  └───────────────────────────────┬───────────────────────────────┘    exchange back
                                  │  embed → upsert (tagged kind=memory)
  ┌─ Adapter layer ───────────────▼───────────────────────────────┐
  │  PgVectorStore — the SAME instance documents use              │
  └───────────────────────────────┬───────────────────────────────┘
                                  │
  ┌─ Storage (agents.chunks) ─────▼───────────────────────────────┐
  │   documents  (kind absent)   +   memory  (kind=memory)        │
  │   ─────────────────────────────────────────────────────────   │
  │   ONE HNSW cosine index over vector(768) serves BOTH          │
  └───────────────────────────────┬───────────────────────────────┘
                                  │  next turn: search_knowledge_base
                                  ▼  recalls documents AND memory, ranked
                          relevant past exchange surfaces as a top hit
```

Read that bottom band out loud if you want — it's the whole insight in one line: *one index, two kinds of row, recalled by the same tool.*

## The body — the three sentences

You say roughly three sentences over this diagram. Rehearse them tight; this is where presenters ramble.

```
  SHOW (on screen / slide)            SAY (out loud)
  ────────────────────────────────    ─────────────────────────────────
  point at the "memory.remember"      "After every turn, buffr embeds
  arrow                                the exchange and writes it back
                                       into the same vector store the
                                       documents live in."
  point at the chunks band — two      "So a memory and a document are
  kinds of row, one index             the same kind of thing — a row
                                       with an embedding, one tagged
                                       'memory'. One index over both."
  point at the search arrow           "Which means recall isn't a new
                                       feature — it's the search tool the
                                       agent already had, now reaching
                                       the conversation's own past."
```

That's it. Three sentences, one diagram. If a judge wants the depth — how the engine over-fetches and filters by `kind`, why the foreign key was deliberately dropped to allow memory rows with no parent document — that's the Q&A (chapter 06) and the deep walk in `study-system-design/06-retrieval-as-memory.md`. On stage, you stop at "same store, same index, same tool."

Here's the move, made explicit, because going too deep here is the classic credibility-beat failure:

```
  WEAK under-the-hood                 STRONG under-the-hood
  ──────────────────────────────      ──────────────────────────────────
  walk the whole stack: Ollama,       one diagram: memory rides the same
  the embedding dims, HNSW params,    store as documents. Three sentences.
  the agent loop, the trace sink…     "Want the depth? Happy to go there
  → 4 minutes gone, room glazed       in Q&A." → 90 seconds, room impressed
```

## The IF-IT-BREAKS box

This chapter has no live beat — it's a diagram and three sentences, so nothing can crash. But it has a failure mode: a judge interrupts with a hard question mid-explanation and you get pulled into the weeds and lose the clock.

```
╔══════════════════════════════════════════════════════════════════╗
║ IF IT BREAKS (you get pulled into the weeds)                      ║
║                                                                    ║
║ A judge interrupts with a deep question here → DO NOT answer it    ║
║ fully now. Say: "great question — let me finish the picture and    ║
║ I'll take that in Q&A." Park it. The deep answer is in            ║
║ study-system-design/06-retrieval-as-memory.md. Protect the clock; ║
║ you still have the close to land.                                 ║
╚══════════════════════════════════════════════════════════════════╝
```

## The "tighten it" cut

Under a tight slot, this whole chapter compresses to one sentence said over the demo's afterglow: *"and the reason it remembers is that memory lives in the same vector store as the documents — same index, same search tool."* You can cut the diagram entirely if the clock demands it. The floor: the room hears *why* the recall is real (shared store), even if they don't see the diagram. This is a ceiling chapter, not a floor chapter — it's the first place to cut when you're running long.

## The one-page run sheet — CHAPTER 03

```
  ┌─ UNDER THE HOOD ─ 6:00–8:00 ─ 2 min ─ one level deep, STOP ──┐
  │                                                              │
  │  ONE DIAGRAM: memory + documents in the same chunks table,   │
  │  one HNSW index, one search tool.                            │
  │                                                              │
  │  THREE SENTENCES (point at the diagram):                     │
  │   1. "after each turn it embeds the exchange back into the   │
  │       same store the documents live in"                      │
  │   2. "a memory and a document are the same kind of row —     │
  │       one index over both"                                   │
  │   3. "so recall isn't a new feature — it's the search tool   │
  │       the agent already had, reaching the past"              │
  │                                                              │
  │  NAIL THIS LINE: "same store, same index, same tool."        │
  │  IF INTERRUPTED: "let me finish the picture, then Q&A."      │
  │  TIGHTEN: cut to ONE sentence, drop the diagram. First place │
  │           to cut when long.                                  │
  └──────────────────────────────────────────────────────────────┘
```

On to chapter 04 — proof it's real.
