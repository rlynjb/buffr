# buffr — Hackathon Demo Book (Overview & Run-of-Show)

> A demo book for presenting **buffr** — the laptop "brain" of a self-hosted personal RAG agent — in a ten-minute hackathon slot. Read the chapters in order once to rehearse; hold the one-page run sheets while you present.

You built a personal RAG agent that runs entirely on your own machine: your corpus in your Postgres, your model on your laptop via Ollama, no cloud in the hot path. It answers questions grounded in your indexed docs, shaped by a stored profile of who you are — and the part that makes a room lean in: **it remembers exchanges from past sessions.** Ask it about something you discussed yesterday and it pulls that exchange back. That's your money shot, and it's real — verified, not a mockup.

This book is built around one hard constraint: **ten minutes, and not one second over.** The demo owns the largest slice. The money shot lands inside the first third. Everything else has a ceiling; the demo has a floor.

## The whole slot on one timeline

Here is the entire ten minutes as one picture — every chapter, its budget, and where the room goes "oh."

```
  THE TEN-MINUTE RUN-OF-SHOW — buffr

  0:00 ┌─────────────────────────────────────────────────────┐
       │ 01  COLD OPEN + ONE-LINER              0:00–1:00     │  1:00
       │       open on chat already answering, grounded       │
  1:00 ├─────────────────────────────────────────────────────┤
       │ 02  THE DEMO (centerpiece)             1:00–6:00     │  5:00
       │       ★ MONEY SHOT — "it remembers me" by ~3:00 ★    │
  6:00 ├─────────────────────────────────────────────────────┤
       │ 03  UNDER THE HOOD                     6:00–8:00     │  2:00
       │       one diagram: memory is RAG over chat history    │
  8:00 ├─────────────────────────────────────────────────────┤
       │ 04  THE BUILD STORY                    8:00–8:45     │  0:45
       │       what shipped + the emulated-tools hard part     │
  8:45 ├─────────────────────────────────────────────────────┤
       │ 05  THE CLOSE + THE ASK                8:45–9:30     │  0:45
       │       the last line they repeat to each other         │
  9:30 ├─────────────────────────────────────────────────────┤
       │     buffer / breathing room            9:30–10:00    │  0:30
 10:00 └─────────────────────────────────────────────────────┘

       06  THE Q&A  ← prep only; runs after the clock,
                       never eats the ten minutes
```

The money-shot marker sits at ~3:00 — inside the first third. That placement is non-negotiable: the room decides early whether this is real, and recall across sessions is the moment that decides it.

## The master demo diagram — what buffr actually does

You will return to this picture in Chapter 02 and 03. It is the one-screen mental model of the whole app: index a corpus once, then every chat turn retrieves, grounds, answers — and *remembers* the exchange for next time. All of it local.

```
  buffr — index once, then (retrieve → ground → answer → remember), all on your laptop

  ┌─ Your terminal (Ink REPL) ────────────────────────────────────┐
  │  npm run chat   →   you ask a question                        │
  └───────────────────────────┬───────────────────────────────────┘
                              │  question
  ┌─ Local pipeline (aptkit, in-process) ──────────────────────────┐
  │  embed query → search store → ground answer → REMEMBER exchange│
  └──────────────┬───────────────────────────────┬─────────────────┘
                 │ search/upsert                  │ generate
  ┌─ Ollama (localhost) ──────────▼──┐   ┌────────▼─────────────────┐
  │  nomic-embed-text (768-dim)      │   │  gemma2:9b (generation)  │
  └──────────────────────────────────┘   └──────────────────────────┘
                 │
  ┌─ Postgres "reindb" / schema "agents" (your machine) ───────────┐
  │  documents + chunks(vector 768, HNSW cosine)                   │
  │     ▲ past exchanges live HERE too, tagged kind=memory          │
  │  conversations · messages · profiles (your me.md)              │
  └────────────────────────────────────────────────────────────────┘

  nothing leaves the laptop — your data, your model, your machine
```

Two true things that picture earns you: it's grounded and cited (documents come back through a search tool), and memories live in the *same* store as documents — so a past exchange resurfaces through the exact same retrieval path. That second fact *is* the money shot.

## The one-liner you open with

This is the sentence the whole presentation hangs on. Say it once, in Chapter 01, close to verbatim.

```
┃ "buffr is a personal RAG agent that runs entirely on my own
┃  laptop — it knows me from a stored profile, and it remembers
┃  me across sessions, because I built it on my own AI toolkit."
```

## How to rehearse this book

Three passes, in order. Do not skip the timer.

```
  REHEARSAL PASSES

  Pass 1 (read + run once)
    → read chapters 01–06 front to back
    → INDEX A CORPUS FIRST (npm run index -- <files>) — without it
      recall has nothing to pull back and the money shot is dead
    → run the demo end-to-end once with a stopwatch
    → note where you ran long

  Pass 2 (run sheets only)
    → run it again holding ONLY the one-page run sheets
    → time the money shot — it must land by ~3:00
    → trigger the IF-IT-BREAKS path on purpose once, so the
      recovery is muscle memory not improvisation

  Night-before / morning-of
    → read only the run sheets
    → confirm: corpus indexed, Ollama up, a prior-session exchange
      already stored, one known-good question, one backup question
    → time the money shot one last time
```

## The pre-flight checklist (do this before you walk on stage)

The demo has live dependencies. Every one of them is a way the demo dies if you skip it. Run this list cold before the slot.

```
  PRE-FLIGHT — all must be green before you present

  [ ] Ollama running, gemma2:9b + nomic-embed-text:v1.5 pulled
  [ ] Postgres up, migrated (npm run migrate done once)
  [ ] A corpus INDEXED (npm run index -- <your .md files>)
  [ ] A profile row loaded (the me.md-style profile in agents.profiles)
  [ ] A PRIOR-SESSION exchange already stored — run a chat session,
      ask + answer something memorable, /exit. THAT is what recall pulls.
  [ ] One known-good grounding question (verified it cites a doc)
  [ ] One known-good recall question (paraphrased — verified it pulls
      the prior exchange as the top hit)
  [ ] A 20-second recorded clip of the money shot working (the backup)
  [ ] eval output captured/screenshot (npm run eval) — for the close
```

## Connect to the rest of the study system

This book presents buffr. When the questions get deep, you have backup:

- **The interview-defense book** (`.aipe/rehearse-interview-defense/`) — answers the "how does it actually work under pressure" follow-ups that come after the slot.
- **`.aipe/study-ai-engineering/`** — the deep mechanics. File `08-conversation-memory.md` is the money shot's engine; `04-gemma-tool-call-emulation.md` is the honest risk you choreograph around.
- **`.aipe/study-system-design/`** — boundaries, the library seam, the storage story for the privacy angle.

You are not starting cold on any judge question — the depth is already written. This book is the front-of-house; those are the back-of-house.
