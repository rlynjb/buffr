# Chapter 02 — The Demo   (1:00–6:00, 5 minutes)

## Opening hook

This is the centerpiece, and it gets the most clock because it carries the whole presentation. Five minutes, one running app, one moment the room reacts. Everything before this set it up; everything after explains it. If you nail nothing else, nail this: **by ~3:00 the room sees buffr recall an exchange from a prior session, and someone in the room thinks "wait — it remembers me."** That is the money shot. It is real and verified — a paraphrased query retrieved a stored past exchange as the top hit. You are not promising a feature; you are showing one.

The structure of these five minutes is deliberate. You earn trust first (grounded, cited, knows-you), then you spend that trust on the wow (remembers-you), then you bank a second, quieter wow (it's all local — your data, your machine). Trust, then wow, then the privacy kicker. Don't reorder it: the recall moment is only impressive *because* the room already believes the basic thing works.

## The time-budget bar

You own five minutes — the largest slice in the slot. The money shot lands inside the first third of the *whole presentation*, by roughly 3:00.

```
  ┌──────────────────────────────────────────────────────────┐
  │ ░░░░░▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
  │ 0:00   1:00 ─────── ★3:00★ ─────── 6:00 ─────────── 10:00 │
  │        THE DEMO — you own 1:00 to 6:00 (5 min)             │
  │        ★ MONEY SHOT lands by ~3:00 ★                       │
  └──────────────────────────────────────────────────────────┘
```

## The chapter-opening diagram — the click-path

Here is the exact path through the running app, beat by beat, with the money shot marked. You walk this top to bottom and do not deviate.

```
  THE DEMO CLICK-PATH — three beats, money shot in the middle

  ┌─ BEAT A (1:00–2:15) · grounded + cited + knows-you ──────────┐
  │  chat REPL → ask a question your indexed docs answer          │
  │  → grounded answer comes back, cites the source               │
  │  → it's shaped by your stored profile (it answers like it     │
  │    knows who you are)                                          │
  └───────────────────────────┬──────────────────────────────────┘
                              │  "now watch this"
  ┌─ BEAT B (2:15–3:30) · ★ THE MONEY SHOT ★ · remembers-you ────┐
  │  ask about something discussed in a PRIOR session,            │
  │  PARAPHRASED (not the exact words)                            │
  │  → buffr pulls the past exchange back as the top hit          │
  │  → "it remembers me." ← the room reacts HERE (~3:00)          │
  └───────────────────────────┬──────────────────────────────────┘
                              │  "and all of this…"
  ┌─ BEAT C (3:30–5:30) · the privacy kicker · all-local ────────┐
  │  show: Ollama on localhost, Postgres on your machine          │
  │  → no cloud in the hot path, your data never leaves           │
  │  (≤2 min — a claim with one piece of evidence, then stop)     │
  └───────────────────────────────────────────────────────────────┘
```

Hold that shape: trust (A) → wow (B) → kicker (C). The money shot is Beat B, and it is scheduled to land by ~3:00. Now walk each beat.

## The body — the beats in order

### Beat A — grounded, cited, knows you (1:00–2:15)

You carried a grounded answer over from the cold open, so the room already half-believes it. Beat A makes the belief solid and adds the "knows me" layer. Ask a question where the *profile* shapes the answer — something where buffr responding generically vs responding *as if it knows you* is visibly different.

```
  SHOW (on screen)                 SAY (out loud)
  ───────────────────────────      ─────────────────────────────────
  ask a profile-shaped question    "It's not a blank assistant — it
  (e.g. "what should I focus on     answers shaped by a stored profile
   given what I work on?")           of who I am and what I do…"

  grounded answer streams,         "…and everything it says is pulled
  citing your indexed docs          from my own indexed notes — see
                                    the source it's grounding on."

  point at the cited source        "That's RAG: retrieve, then answer
                                    only from what it retrieved."  ← trust banked
```

The SAY track sells *grounded* and *knows-me* — never "I'm typing now." By the end of Beat A the room believes buffr is real and personal. That belief is the fuel for Beat B.

### Beat B — THE MONEY SHOT: it remembers you (2:15–3:30)

This is the moment. Everything is staged for it: you indexed a corpus, you ran a prior session and stored a memorable exchange, you have a paraphrased question ready. Now you set it up with one sentence, fire the question, and let the room watch a *past conversation* come back.

```
  SHOW (on screen)                 SAY (out loud)
  ───────────────────────────      ─────────────────────────────────
  (set up first, hands still)      "Here's the part that got me. Earlier
                                    — in a totally separate session — I
                                    talked to it about something."

  type a PARAPHRASED question       "I'm not going to repeat what I said.
  about that prior exchange         I'll ask it sideways, different words…"
  → enter

  buffr surfaces the PAST          "…and it pulls back what we talked
  exchange as the top hit,          about before. It remembers me —
  weaves it into the answer         across sessions."        ← ★ MONEY SHOT ★
```

Then stop talking. Let it land. The single strongest move you can make here is silence for one beat while the room reads the screen. The line to say, once, right after:

```
┃ "That's not a saved chat log — it retrieved a past exchange
┃  by meaning, the same way it retrieves my documents."
```

That sentence is load-bearing: it tells the room the recall is *retrieval*, not a transcript scroll — which is what makes it impressive to anyone who knows what a chat log is. Say it and let it breathe. Do not rush into Beat C.

### Beat C — the privacy kicker: it's all yours (3:30–5:30)

The room is warm. Bank the second wow without over-explaining. One claim, one piece of evidence, then stop — this beat has a hard ceiling and you protect the buffer.

```
  SHOW (on screen)                 SAY (out loud)
  ───────────────────────────      ─────────────────────────────────
  a second pane: Ollama on         "And all of this is mine. The model
  localhost:11434, Postgres         is gemma2:9b running on my laptop
  running locally                   via Ollama — nothing's calling out."

  point at the local DB            "The corpus, the memory, the profile —
                                    all in my own Postgres, on this
                                    machine. No cloud in the hot path."

  (resist the urge to go deeper)   "Your data, your model, your machine.
                                    That's the whole pitch."  ← kicker banked
```

Then you are done with the demo with time to spare. Hand to Chapter 03 with: "let me show you the one trick that makes the memory work."

## Strong vs weak — the demo

The failure mode that wastes the money shot is burying it or over-narrating it. Here is the contrast.

```
  WEAK DEMO                          STRONG DEMO
  ─────────────────────────────      ─────────────────────────────────
  spends 3 min on grounded RAG       grounded RAG in ~75 sec (trust),
  (which judges have seen 50x),       then the money shot by ~3:00 —
  recall shows up at minute 5         the thing they HAVEN'T seen, early
  if there's time left

  narrates the recall: "so now       sets it up, fires it, then SILENCE —
  the system embeds the query and     lets the room read the screen and
  searches the vector store and…"     react before explaining anything

  → the wow is buried + explained    → the wow lands early + lands clean
     to death                           (explain the mechanism in 03)
```

## The IF-IT-BREAKS box

Two real risks live in this chapter, and the money shot is one of them. Emulated tool-calling means Gemma can skip the search tool; if it does, recall doesn't surface. You have a recovery for each.

```
╔══════════════════════════════════════════════════════════════════╗
║ IF IT BREAKS — the money shot doesn't recall                     ║
║                                                                   ║
║ Gemma answered Beat B without pulling the past exchange (it       ║
║ skipped the search tool — emulated tools, it happens):           ║
║   1. Don't re-type frantically. Say: "let me ask that more        ║
║      directly" and fire your BACKUP recall question — the one     ║
║      you verified pre-flight pulls the prior exchange as top hit. ║
║   2. Still whiffs → cut to the 20-SECOND RECORDED CLIP of the     ║
║      money shot working. Say: "here it is from earlier — it       ║
║      pulled back a past exchange across sessions." Keep energy up.║
║                                                                   ║
║ The recorded clip is your insurance. It exists because emulated   ║
║ tool-calling is the one thing in this demo you can't fully trust  ║
║ live. Never apologize twice. Never freeze. Keep moving.           ║
╚══════════════════════════════════════════════════════════════════╝
```

## The "tighten it" treatment

If you are running long when you hit the demo, cut Beat C first — never the money shot.

```
  TIGHTEN IT
    cut first:  Beat C (the privacy kicker) down to one sentence —
                "and it's all running locally, your data never leaves."
                No second pane, no Ollama/Postgres show-and-tell.
    cut next:   Beat A's profile question — go straight from the
                cold-open grounded answer into "now watch this."
    floor:      Beat B, the money shot, is sacred. The room MUST see
                recall across sessions work. Cut anything else first.
```

## The one-page run sheet — THE DEMO

```
  ┌─ RUN SHEET · 02 THE DEMO · 1:00–6:00 · ★MONEY SHOT ~3:00★ ──────┐
  │                                                                 │
  │  BEAT A (→2:15) grounded + knows-you                            │
  │   • "answers shaped by a stored profile of who I am"            │
  │   • "everything pulled from my own indexed notes — the source"  │
  │                                                                 │
  │  BEAT B (→3:30) ★ MONEY SHOT — it remembers you ★               │
  │   • "earlier, in a SEPARATE session, I talked to it about X"    │
  │   • "I'll ask it sideways, different words…" (PARAPHRASE)        │
  │   • [it pulls the past exchange back] → SILENCE, let it land    │
  │   • LINE: "not a saved chat log — it retrieved a past exchange  │
  │            by meaning, like it retrieves my documents."         │
  │                                                                 │
  │  BEAT C (→5:30) the privacy kicker (≤2 min, then STOP)          │
  │   • "model on my laptop via Ollama, nothing calls out"          │
  │   • "corpus + memory + profile in my own Postgres"              │
  │   • "your data, your model, your machine."                      │
  │                                                                 │
  │  IF MONEY SHOT WHIFFS: backup recall Q → still no? 20-sec clip. │
  │  TIGHTEN: cut Beat C to one line, then Beat A. Beat B is sacred.│
  └─────────────────────────────────────────────────────────────────┘
```
