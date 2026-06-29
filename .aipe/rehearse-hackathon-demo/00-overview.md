# Overview — the run-of-show for buffr

You have ten minutes and a room watching a clock. This book is the script. Read it front-to-back twice to rehearse, then hold the one-page run sheets at the back of each chapter while you present.

Here's the thing you're demoing, said plainly: **buffr is a self-hosted personal RAG agent that knows you and remembers you — your data on your Postgres, your model on your laptop, built on your own aptkit toolkit.** The room doesn't need that sentence yet. They need to see it remember a past conversation. That's the whole game.

## The whole slot on one timeline

This is the shape of the ten minutes. The demo owns the middle and the money shot lands early — the room reacts inside the first third, then you spend the rest earning the reaction you already got.

```
  THE TEN-MINUTE RUN-OF-SHOW — buffr

  0:00 ┌──────────────────────────────────────────────────────┐
       │ 01  COLD OPEN + ONE-LINER                  0:00–1:00  │  1:00
       │       open on a live answer, cited, on your laptop    │
  1:00 ├──────────────────────────────────────────────────────┤
       │ 02  THE DEMO (centerpiece)                 1:00–6:00  │  5:00
       │   ┌─ grounded answer + citation       ~1:00–2:30      │
       │   │  ★ THE MONEY SHOT: "it remembers   ~2:30–3:00 ★   │ ◄ by 3:00
       │   │     me" — recalls a PRIOR session                 │
       │   └─ self-hosted / local privacy beat  ~3:00–6:00     │
  6:00 ├──────────────────────────────────────────────────────┤
       │ 03  UNDER THE HOOD                         6:00–8:00  │  2:00
       │       one diagram: memory rides the same vector store │
  8:00 ├──────────────────────────────────────────────────────┤
       │ 04  THE BUILD STORY                        8:00–8:45  │  0:45
       │       what shipped + the emulated-tool-calling crack  │
  8:45 ├──────────────────────────────────────────────────────┤
       │ 05  THE CLOSE + THE ASK                    8:45–9:30  │  0:45
  9:30 ├──────────────────────────────────────────────────────┤
       │     buffer / breathing room                9:30–10:00 │  0:30
 10:00 └──────────────────────────────────────────────────────┘

       06  THE Q&A  ← prep only; runs AFTER the clock,
                       never eats the ten minutes
```

The money shot is named, and it is scheduled at **2:30–3:00** — inside the first third. You do not bury "it remembers me" in minute eight. You land it before the room has finished deciding whether to care, and then everything after is gravy.

## The master demo diagram — what the app does on one screen

Before the run-of-show, fix this picture in your head. It's the one-screen mental model of buffr, and it reappears in chapter 02 (the demo) and chapter 03 (under the hood). Everything in your demo is a path through this diagram.

```
  buffr — one self-hosted loop on your laptop

  ┌─ Your laptop ─────────────────────────────────────────────────┐
  │                                                                │
  │   you ──ask──►  npm run chat  (Ink terminal UI)                │
  │                      │                                         │
  │                      ▼                                         │
  │              RagQueryAgent ──► Gemma (gemma2:9b via Ollama)    │
  │                      │              local model, no cloud      │
  │                      │ search_knowledge_base tool              │
  │                      ▼                                         │
  │              retrieval pipeline ──► PgVectorStore              │
  │                                          │                     │
  └──────────────────────────────────────────┼─────────────────────┘
                                             │ pgvector, 768-dim
  ┌─ Your Postgres (reindb, schema agents) ──▼─────────────────────┐
  │   chunks  ──  documents (your indexed corpus)                  │
  │           └─  memory   (past exchanges, kind=memory)           │
  │   ONE HNSW index serves both → recall surfaces BOTH            │
  └────────────────────────────────────────────────────────────────┘

  the money shot: the "memory" rows are why a question about a PRIOR
  session comes back with the past exchange as the top hit.
```

The one non-obvious thing in that diagram — the thing chapter 03 spends its two minutes on — is that **memory and documents live in the same table, served by the same index, recalled through the same tool.** Memory isn't a bolt-on subsystem. It's retrieval pointed at the conversation's own history. That's why "it remembers me" is real and not a trick.

## How to rehearse this (the reading order)

Three passes. Do not skip the first one — the timer is the whole point.

```
  REHEARSAL PLAN

  Pass 1  (read + run)   Read all six chapters in order. Then run
                         the demo ONCE, end to end, with a timer
                         visible. Note where you ran long.

  Pass 2  (run sheets)   Run it again holding ONLY the one-page run
                         sheets at the back of each chapter. If you
                         need the full chapter, you haven't rehearsed
                         it enough.

  Night-before /         Read only the run sheets. Time the money
  morning-of             shot — it must land by 3:00. Confirm the
                         pre-flight checklist (below) is green.
```

## The pre-flight checklist — do this BEFORE you present

This is non-negotiable and it is the difference between a demo that lands and a demo that has nothing to recall. The money shot depends on state that must exist *before* you walk on stage.

```
  PRE-FLIGHT — run these the hour before, in order

  [ ] npm run migrate          schema exists (one-time; safe to re-run)
  [ ] npm run index -- <your corpus .md files>
                               a RELIABLE corpus is indexed — the docs
                               your grounded answer will cite
  [ ] open npm run chat, ask your money-shot question ONCE, let it
      answer. This SEEDS the prior-session memory you'll recall later.
      Then /exit. (A fresh session recalls it because memory is
      cross-session — it rides the store, not the process.)
  [ ] npm run eval             read your REAL P@1 / R@3 number off the
      screen and write it on your run sheet. Never quote a number you
      didn't just see.
  [ ] record a 25-second screen clip of the money shot working, as the
      IF-IT-BREAKS fallback (chapter 02).
  [ ] ollama is up; gemma2:9b + nomic-embed-text:v1.5 are pulled.
```

If you index nothing, recall has nothing to surface and the money shot dies. If you don't seed a prior exchange, "it remembers me" has no memory to remember. The pre-flight *is* the demo.

## Where this sits in the rest of the study system

This book presents buffr. It is not the only artifact you have for it.

```
  THE STUDY FAMILY, FOR buffr

  this book                  → SHOW it (a room, a clock, the money shot)
  .aipe/study-system-design/ → the "how does it actually work" answers
       06-retrieval-as-memory.md  ← the deep walk behind the money shot
  .aipe/study-ai-engineering/
       04-agents-and-tool-use/02-tool-calling.md
                             ← the emulated-tool-calling honesty (ch 04 + 06)
       05-evals-and-observability/02-eval-methods.md
                             ← what your eval number means (ch 06)
```

When a judge drills past what you showed — "how does the memory actually work, is it just stuffing history into the prompt?" — the answer lives in `study-system-design/06-retrieval-as-memory.md`. You don't need it on stage. You need it in your back pocket for the Q&A (chapter 06).

Now go to chapter 01. Open on the thing working.
