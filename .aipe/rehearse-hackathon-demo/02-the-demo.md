# Chapter 02 — The demo   (1:00–6:00, 5 minutes)

## Opening hook

This is the chapter that wins or loses the demo, and it owns half the slot. Everything else — the architecture, the build story, the close — exists to support the five minutes you spend here. You have one job: make the room *feel* "it remembers me" before the clock hits 3:00, then spend the rest of the time letting that land and showing it's not a parlor trick.

Three beats, in order, and they escalate. First a grounded, cited answer (proves it's a real RAG agent, not a chatbot). Then the money shot — you ask about something from a *prior* session and it recalls the exchange (proves it remembers). Then the privacy beat — you point out the whole thing ran with no network (proves the wow is also yours, locally, nobody else's). Grounded, then memory, then private. The middle one is the moment the room reacts.

## The time-budget bar

You own 1:00 to 6:00 — the largest block in the slot — and the money shot lands by 3:00, inside the first third.

```
  ┌──────────────────────────────────────────────────────┐
  │ ░░░░░▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
  │ 1:00 ──────────── 6:00 ────────────────────────── 10:00 │
  │       THE DEMO — you own 1:00 to 6:00 (5 min)          │
  │       ★ money shot at ~2:30–3:00 ★                     │
  └──────────────────────────────────────────────────────┘
```

## The chapter-opening diagram — the click-path

This is the exact sequence of beats, with the money shot marked. Walk it left to right; never skip ahead. The whole demo is one pass through this path.

```
  THE DEMO CLICK-PATH — three escalating beats

  1:00          2:00            2:30 ─ 3:00          3:00         6:00
   │             │                  │                  │            │
   ▼             ▼                  ▼                  ▼            ▼
  ┌───────────┐ ┌───────────────┐ ┌────────────────┐ ┌──────────────┐
  │ BEAT 1    │ │ set up the    │ │ ★ BEAT 2       │ │ BEAT 3       │
  │ grounded  │→│ recall: name  │→│ MONEY SHOT      │→│ privacy /    │
  │ + cited   │ │ the prior     │ │ ask about a    │ │ self-hosted  │
  │ answer    │ │ session       │ │ PRIOR session  │ │ beat         │
  │           │ │ out loud      │ │ → it RECALLS   │ │ "no network" │
  └───────────┘ └───────────────┘ └────────────────┘ └──────────────┘
   proves it     primes the room   "it remembers me"  proves it's
   retrieves     to recognize it   ◄ THE REACTION     yours, local
                                      lands by 3:00

  the corpus + a prior exchange were SEEDED in pre-flight, or beat 2
  has nothing to recall. (See overview pre-flight checklist.)
```

The single most important scheduling fact in this whole book: **the money shot is beat 2, and it lands by 3:00.** If you find yourself at 3:30 still on beat 1, cut into beat 2 immediately. The room will forgive a rushed grounded-answer beat; it will not forgive a buried money shot.

## The body — the three beats

### Beat 1 — the grounded, cited answer (1:00–2:00)

You may have already shown a version of this in the cold open. Here you do it deliberately and point at the grounding. The value you're speaking is *it doesn't make things up — it retrieves from your real corpus and tells you the source.*

```
  SHOW (on screen)                    SAY (out loud)
  ────────────────────────────────    ─────────────────────────────────
  type a question about your          "I'll ask it something only my
  indexed notes, hit enter             notes would know."
  spinner: "thinking…"                (silence — let it work)
  answer prints, grounded, with a     "Notice it didn't guess — it
  citation to the source doc           retrieved that from a document I
                                       indexed, and it shows me which
                                       one."
```

Speak value, not clicks. Banned: "now I'm typing a question and pressing enter." The hands do that; your mouth says why it matters.

### Beat 2 — THE MONEY SHOT (2:30–3:00): it remembers a prior session

This is the moment. Two micro-steps: first you *prime* the room by naming, out loud, that you talked about something earlier in a different session. Then you ask about it — phrased differently than you asked the first time — and it comes back having recalled the earlier exchange. The paraphrase matters: it proves this is *semantic* recall, not string-matching. (Verified: a paraphrased query retrieved the stored exchange as the top hit.)

```
  SHOW (on screen)                    SAY (out loud)
  ────────────────────────────────    ─────────────────────────────────
  [fresh chat session — you can       "Here's the part I think is
   even point out it's a NEW           different. Earlier, in a totally
   session]                            separate conversation, I told
                                       buffr something about myself."
  type a PARAPHRASED question about    "I'm not going to repeat it the
  that earlier exchange, hit enter     same way — I'll ask it sideways."
  spinner: "thinking…"                (silence — this is the beat; let
                                       the room lean in)
  the answer comes back having         "…and it remembered. That's a
  RECALLED the prior exchange —        conversation from before, in a
  surfaces what you told it earlier    different session, that it pulled
                                       back on its own."          ◄ ★ MONEY SHOT
```

Then the line. Say it, then stop talking. Let the silence do the work — the reaction happens in the pause, not over your voice.

```
┃ "It remembers me. Different session, no history pasted in — it
┃  retrieved the past conversation because it was relevant."
```

That pause is the highest-value silence in your ten minutes. Do not fill it.

### Beat 3 — the privacy beat (3:00–6:00): it's yours, locally

The room is sold on memory. Now you collapse the second wow into it: all of that — the grounding, the recall — happened with no network in the path. The model is on your laptop (Gemma via Ollama), the data is on your Postgres. You can dramatize it.

```
  SHOW (on screen)                    SAY (out loud)
  ────────────────────────────────    ─────────────────────────────────
  (optional, high-impact) turn wifi   "Everything you just saw — the
  OFF, or show it's already off,       answer, the memory — ran with no
  then ask one more grounded           internet. The model's on this
  question                             laptop, the data's in my own
                                       Postgres."
  answer still comes back, grounded   "Nothing I tell it ever leaves the
                                       machine. It's my second brain,
                                       and it's actually mine."
```

If you turn wifi off live, do it as a small piece of theater — "watch, I'll kill the network" — and ask one more question so the room sees it still answer. That's the privacy story made physical. If you'd rather not risk it, just say it; the claim is true either way (no cloud in the hot path — `src/session.ts` wires Ollama + PgVectorStore, no remote model call).

## The IF-IT-BREAKS box

Two failure modes, two backups. The money shot has the worst-case fallback because it's the beat that matters most.

```
╔══════════════════════════════════════════════════════════════════╗
║ IF IT BREAKS                                                       ║
║                                                                    ║
║ BEAT 1 (grounded answer) ungrounded / no citation → re-ask the    ║
║ known-good question once ("let me ask that more directly"). Almost ║
║ always grounds on retry. Emulated tool-calling occasionally skips  ║
║ the search tool — this is the recovery for it.                    ║
║                                                                    ║
║ BEAT 2 (MONEY SHOT) doesn't recall → DO NOT freeze. Re-ask once,   ║
║ phrased closer to the original wording (less paraphrase = easier   ║
║ recall). If it still misses → cut to the 25-second recorded clip   ║
║ of the recall working. Say: "here it is from earlier — watch it    ║
║ pull back the past conversation." The clip IS the money shot if    ║
║ live won't cooperate. You rehearsed this; you do not apologize.    ║
╚══════════════════════════════════════════════════════════════════╝
```

The recovery ladder for the money shot, in order, so you never have to think on stage: **paraphrased ask → closer-worded re-ask → recorded clip.** Three rungs. You only fall to the clip if both live attempts miss, and the clip still delivers the wow.

## The "tighten it" cut

Under a tight slot, you cut beat 3, not beat 2. Drop the privacy demo to a single spoken sentence — "and all of this ran locally, no cloud" — and hold the full money shot intact. The demo's floor is **the room sees it recall a prior session.** That is the one thing you never cut. If you have to choose between a polished grounded-answer beat and the money shot, the money shot wins every time.

## The one-page run sheet — CHAPTER 02

```
  ┌─ THE DEMO ─ 1:00–6:00 ─ 5 min ─ ★ money shot by 3:00 ★ ──────┐
  │                                                              │
  │  BEAT 1 (1:00–2:00) grounded + cited                         │
  │    SAY: "something only my notes would know" → on answer:    │
  │         "didn't guess — retrieved it, shows the source"      │
  │                                                              │
  │  BEAT 2 (2:30–3:00) ★ MONEY SHOT — prior-session recall      │
  │    prime: "earlier, a separate conversation, I told it…"     │
  │    ask it SIDEWAYS (paraphrased) → it recalls                │
  │    ┃ "It remembers me. Different session, no history pasted  │
  │    ┃  in — it retrieved the past conversation."  THEN STOP.  │
  │                                                              │
  │  BEAT 3 (3:00–6:00) privacy / local                          │
  │    (optional: kill wifi) "everything ran with no internet —  │
  │     my model, my data, nothing leaves the machine."          │
  │                                                              │
  │  NAIL THIS LINE: "It remembers me." + the pause after.       │
  │  IF IT BREAKS: re-ask → closer re-ask → 25-sec clip.         │
  │  TIGHTEN: cut beat 3 to one sentence. Floor: room SEES recall.│
  └──────────────────────────────────────────────────────────────┘
```

On to chapter 03 — one level under the hood, then stop.
