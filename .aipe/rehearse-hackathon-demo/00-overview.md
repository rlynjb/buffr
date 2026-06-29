# buffr — Hackathon Demo Book (Overview & Run-of-Show)

You built a self-hosted personal RAG agent (retrieval-augmented
generation — your local `buffr-laptop`) that knows you and remembers you,
running entirely on your laptop and your own database. This book is how you
present it in ten minutes without losing the room. Read it once front to
back with a timer. Then run it again holding only the run sheets. The
morning of, read only the run sheets and time the money shot.

One rule before anything else: the demo is the centerpiece, the money
shot lands inside the first third, and you plan to finish *early*. A
hackathon demo loses by going long far more often than by being too thin.
This book is built to land at 9:30 with thirty seconds of air.

## The whole slot on one timeline

Here is the entire ten minutes — every chapter, its budget, and the one
marked moment the room reacts. Glance at this before you walk on; it is the
shape of the talk.

```
  THE TEN-MINUTE RUN-OF-SHOW — buffr

  0:00 ┌──────────────────────────────────────────────────────┐
       │ 01  COLD OPEN + ONE-LINER                  0:00–1:00  │ 1:00
       │       open on it answering a grounded question        │
  1:00 ├──────────────────────────────────────────────────────┤
       │ 02  THE DEMO (centerpiece)                 1:00–6:00  │ 5:00
       │     ★ MONEY SHOT — "it remembers me"  ~2:45 ★         │
       │       recall of a PRIOR session, across sessions      │
  6:00 ├──────────────────────────────────────────────────────┤
       │ 03  UNDER THE HOOD                         6:00–8:00  │ 2:00
       │       memory rides the SAME vector store              │
  8:00 ├──────────────────────────────────────────────────────┤
       │ 04  THE BUILD STORY                        8:00–8:45  │ 0:45
       │       emulated tool-calling — the hard part           │
  8:45 ├──────────────────────────────────────────────────────┤
       │ 05  THE CLOSE + THE ASK                    8:45–9:30  │ 0:45
       │       the privacy line, the ask, the last sentence    │
  9:30 ├──────────────────────────────────────────────────────┤
       │     buffer / breathing room                9:30–10:00 │ 0:30
 10:00 └──────────────────────────────────────────────────────┘

       06  THE Q&A  ← prep only; runs after the clock,
                       does not eat the ten minutes
```

The money shot sits at roughly 2:45 — inside the first third (0:00–3:20),
exactly where the spec wants it. Everything after it is you earning
credibility, not chasing the wow. If you are running long, you cut from
chapters 3, 4, and 5 — never from the demo's floor (the room sees recall
work).

## The master demo diagram — what buffr actually does

This is the one picture of the app. It recurs in chapter 2. Memorize its
shape: a question goes in, retrieval pulls grounded context *and* past
exchanges from the same store, a local model answers cited and shaped by
your profile.

```
  buffr — one screen, end to end

  ┌─ Your laptop (the whole system runs here) ─────────────────────┐
  │                                                                 │
  │  npm run chat                                                   │
  │  ┌─ Terminal UI (Ink / React-in-terminal) ──────────────────┐  │
  │  │  you:  "what did we decide about embeddings?"            │  │
  │  └────────────────────────┬─────────────────────────────────┘  │
  │                           │ ask(question)                       │
  │  ┌─ Agent loop ───────────▼─────────────────────────────────┐  │
  │  │  RagQueryAgent → search_knowledge_base tool              │  │
  │  └───────┬───────────────────────────────────┬──────────────┘  │
  │          │ embed + ANN search                 │ generate        │
  │  ┌───────▼─────────────────────┐    ┌─────────▼──────────────┐  │
  │  │ Postgres + pgvector         │    │ Gemma (gemma2:9b)      │  │
  │  │ chunks(embedding vector768) │    │ via Ollama, on-device  │  │
  │  │   • indexed docs            │    │ + your profile in the  │  │
  │  │   • PAST EXCHANGES          │    │   system prompt        │  │
  │  │     (kind='memory')         │    └────────────────────────┘  │
  │  └─────────────────────────────┘                                │
  │   your data, your DB              your model, your machine       │
  └─────────────────────────────────────────────────────────────────┘
```

The thing to notice — and the spine of the whole demo — is that past
exchanges live in the *same* `chunks` table as your indexed documents,
tagged `kind='memory'`. That single design choice is why recall works
through the tool the agent already has. The money shot and chapter 3 both
hang off this picture.

## How to rehearse this book

```
  THREE PASSES — escalating from script to muscle memory

  Pass 1  ─ read all 7 chapters in order, run the demo ONCE
            end-to-end with a timer. Find where you run long.
            DO THIS WITH A CORPUS ALREADY INDEXED + a prior-
            session exchange already stored. (see chapter 2)

  Pass 2  ─ run it again holding ONLY the run sheets. Talk to
            the SAY track, let your hands do the SHOW track.
            Time the money shot — it must land by 3:20.

  Pass 3  ─ morning-of: read only the run sheets. Rehearse the
            ONE money-shot line and the ONE closing line until
            they are verbatim. Pre-flight the IF-IT-BREAKS gear.
```

The non-negotiable pre-flight, because buffr's recall has nothing to
recall without it: **before you present, run `npm run migrate` once, index
a reliable corpus with `npm run index -- <file.md>`, and have at least one
real prior-session exchange already stored** (open `npm run chat`, ask the
question you'll later paraphrase, let it answer, exit). Recall retrieves
from what's in the store. An empty store is a dead money shot.

## Where this book sits in the rest of the study system

This book *presents* buffr. Two siblings answer what comes after:

```
  the study family — three rooms, three jobs

  this book        → SHOW it   (a room watches a clock; land the wow)
  rehearse-        → DEFEND it  (an interviewer drills "why this way")
   interview-          .aipe/rehearse-interview-defense/  (not yet generated)
   defense.md
  study-system-    → UNDERSTAND it  (the deep walk of each mechanism)
   design/            .aipe/study-system-design/
```

When a judge asks "how does the memory actually work," you have one level
in chapter 3 — and the full answer in
`.aipe/study-system-design/05-long-lived-chat-session.md` and
`.aipe/study-ai-engineering/03-retrieval-and-rag/`. The cross-links live in
chapter 6 (the Q&A).

## The chapter map

```
  .aipe/rehearse-hackathon-demo/
    00-overview.md          ← you are here: the run-of-show
    01-the-cold-open.md     ← first 60s: hook + the one-liner
    02-the-demo.md          ← the live walk + the money shot (centerpiece)
    03-under-the-hood.md    ← one mechanism: memory in the same store
    04-the-build-story.md   ← what shipped + the emulated-tools hard part
    05-the-close.md         ← the privacy vision, the ask, the last line
    06-the-qa.md            ← judge questions + answers (post-clock prep)
```

Read on to chapter 1. Open cold, in motion, on the thing working.
