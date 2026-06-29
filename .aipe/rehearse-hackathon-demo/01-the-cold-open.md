# Chapter 1 — The Cold Open   (0:00–1:00, 60 seconds)

## Opening hook

You have sixty seconds, and the room decides inside the first twenty
whether this is real software or a slide deck. Do not spend them on a title
card, your name, or "so the problem we set out to solve…". Open with buffr
*answering a question*, on your screen, live. The room should see a working
terminal before they hear what it is. You name the thing only after they've
seen it move.

This is the discipline this chapter trains: start in motion. The most
common way to lose the cold open is ninety seconds of setup the room
doesn't need yet — what RAG is, why local matters, who you are. Cut all of
it. Show first. The one-liner lands *after* the first answer, not before.

## The time-budget bar

You own the first minute. By 1:00 the room must have seen buffr answer one
grounded question and heard one sentence telling them what it is.

```
  ┌──────────────────────────────────────────────────────┐
  │ ▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
  │ 0:00 ─ 1:00 ──────────── 6:00 ─────────────── 10:00   │
  │      COLD OPEN — you own 0:00 to 1:00 (60 sec)        │
  └──────────────────────────────────────────────────────┘
```

## The attention curve — where the cold open has to put the room

The room's attention is highest at second zero and decays fast if nothing
happens. Your job is to spend that peak on the thing working, then convert
it into a held curiosity that carries into the demo. Here is the shape you
are steering.

```
  The room's attention over the first 60 seconds

  high │█
       │█▓
  att  │█▓▓        ← title slide here = curve falls off a cliff
  ent  │█▓▓▓
  ion  │█▓▓▓▓░░░░░░░░░░░░░░  (a demo that opens cold and slow)
       │
       └────────────────────────────────────────────── time

  high │█  ★ buffr answers a grounded, cited question
       │█▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  ← curiosity HELD into the demo
  att  │█▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓     "...and it remembers me. watch."
  ent  │█
  ion  │
       └────────────────────────────────────────────── time
              ▲
              open ON the answer, name it AFTER
```

The top curve is the demo that opens on a title and explains for a minute;
the room is already drifting by the time anything runs. The bottom curve is
yours: the working answer spends the attention peak, and the one-liner
converts it into a question the room now wants answered ("wait — it
remembers?"). Hold that curiosity; chapter 2 pays it off.

## The body — the two beats in order

Two beats only: the **hook** (it answers, live) and the **one-liner** (what
it is, in one sentence). Choreograph them as SHOW against SAY so your mouth
speaks value while your hands type.

### Beat 1 — the hook (0:00–0:35)

You walk on with `npm run chat` already running, or you run it as your
first move so the room sees a real terminal, not a mockup. You type one
question you *know* hits the indexed corpus, and it answers — grounded and
cited.

```
  SHOW (on screen)                  SAY (out loud)
  ────────────────────────────      ──────────────────────────────
  npm run chat — the Ink            "This is my notes. It runs on
  terminal UI, already up           my laptop — nothing in the
                                     cloud. Watch."
  type a question that hits         "I ask it something from my
  the indexed corpus, hit enter     own indexed docs…"
  the answer streams back,          "…and it answers — grounded in
  grounded + cited                   my notes, not made up."
```

Do not narrate the typing. "Now I'm typing a question into the prompt" is
the dead-air failure. The SAY track is the value — *it runs locally, it's
grounded in my own notes* — while your hands do the typing the room can
already see.

### Beat 2 — the one-liner (0:35–1:00)

Now, and only now, you name it. The form is "X is a Y that does Z for W":

```
  ┃ "buffr is a personal AI agent that runs entirely on my laptop —
  ┃  it answers grounded in my own documents, and it remembers our
  ┃  past conversations."
```

That sentence does three jobs: names the category (personal AI agent),
names the local-first twist (entirely on my laptop), and plants the money
shot you're about to pay off (it remembers). Say it close to verbatim. Then
go straight into the demo — no breath, no "so let me show you more."

One more script line to have ready, the bridge into chapter 2:

```
  ┃ "Grounded answers are table stakes now. Here's the part that
  ┃  isn't — watch it remember something from a conversation we had
  ┃  before."
```

## Strong vs weak — the cold-open move

The contrast is the lesson. One of these openings keeps the room; the other
loses it before the demo starts.

```
  WEAK open                          STRONG open
  ──────────────────────────         ──────────────────────────────
  title slide: "buffr — a            terminal already live; type a
  self-hosted personal RAG           question; it answers grounded
  agent"                             + cited in the first 15 seconds

  "Let me explain what RAG is        name it in ONE sentence AFTER
  and why local-first matters…"      the room has seen it work

  your name, your background,        the one-liner plants the money
  the team, the inspiration          shot: "…and it remembers me"

  room is drifting by 0:45           room is leaning in by 0:45
```

## The IF-IT-BREAKS box

The cold open is on a live model on your laptop. The two ways it bites: the
model answers *without* searching (emulated tool-calling — see chapter 4),
or the terminal is slow to spin up. Have the recovery ready before you walk
on.

```
  ╔══════════════════════════════════════════════════════════════╗
  ║ IF IT BREAKS                                                  ║
  ║ buffr answers but ISN'T grounded (skipped the search tool) → ║
  ║ stay calm, say "let me ask that more directly" and re-ask    ║
  ║ with your KNOWN-GOOD backup question (the one you rehearsed   ║
  ║ that reliably triggers the tool). Do NOT re-roll the same     ║
  ║ phrasing live.                                                ║
  ║                                                               ║
  ║ chat won't start / model cold → switch to the 20-second      ║
  ║ pre-recorded clip of the grounded answer. Say: "here it is   ║
  ║ from a run a minute ago" and keep the energy up. Never        ║
  ║ apologize twice, never freeze.                                ║
  ╚══════════════════════════════════════════════════════════════╝
```

## The "tighten it" treatment

Running long going in? Cut Beat 1's second exchange — one grounded answer
is enough to earn the one-liner. **Floor: the room sees buffr answer one
real question before you name it.** Never open on the one-liner with no
working answer behind it; that turns your cold open back into a slide.

## The one-page run sheet — Chapter 1

```
  ┌─ COLD OPEN ─────────────────── 0:00–1:00 (60s) ──────────────┐
  │                                                               │
  │  SAY, in order:                                               │
  │   • "Runs on my laptop. Nothing in the cloud. Watch."         │
  │   • "I ask it something from my own indexed docs…"            │
  │   • "…and it answers — grounded in my notes, not made up."    │
  │   • [THE ONE-LINER, verbatim ↓]                               │
  │   • "Grounded is table stakes. Here's the part that isn't…"   │
  │                                                               │
  │  NAIL THIS LINE:                                              │
  │   "buffr is a personal AI agent that runs entirely on my      │
  │    laptop — grounded in my own documents, and it remembers    │
  │    our past conversations."                                   │
  │                                                               │
  │  IF IT BREAKS: not grounded → re-ask with known-good backup   │
  │   question. won't start → 20-sec recorded clip, keep energy.  │
  │                                                               │
  │  TIGHTEN: drop the 2nd exchange. FLOOR: one real answer       │
  │   before you name it.                                         │
  └───────────────────────────────────────────────────────────────┘
```

Next: chapter 2, the demo. You've planted "it remembers." Now pay it off.
