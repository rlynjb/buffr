# Chapter 01 — The Cold Open   (0:00–1:00, 1 minute)

## Opening hook

You have sixty seconds before the room decides whether to pay attention, and you are going to spend zero of them on a title slide. Here is the trap I have watched kill a hundred hackathon demos: the presenter opens with "hi, I'm X, and today I want to talk about a problem that affects all of us…" — and by the time the actual thing appears on screen, the judges have already half-checked-out. Don't do that. Open with buffr *already answering a question*, grounded in your own docs, on your own laptop. The thing working is the hook. The introduction comes after the room is already leaning in.

The cold open does two jobs and then gets out of the way: land the **hook** (the app visibly working) and land the **one-liner** (what this is, in one breath). That's it. No architecture, no "let me set the stage," no apologizing for the terminal UI. You are in motion before you say your name.

## The time-budget bar

You own the first minute. Get the app answering and the one-liner said, then hand straight to the demo.

```
  ┌──────────────────────────────────────────────────────────┐
  │ ▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
  │ 0:00 ── 1:00 ────────────────────────────────────── 10:00 │
  │        THE COLD OPEN — you own 0:00 to 1:00 (1 min)        │
  └──────────────────────────────────────────────────────────┘
```

## The chapter-opening diagram — the room's attention curve

Here is what you are actually managing in this minute: the room's attention. It is highest the instant you start and decays fast if nothing happens. Your job is to spend a spike of attention on the thing working before it decays, so the room is already invested when the real demo starts.

```
  THE ATTENTION CURVE — spend the opening spike on the thing WORKING

  attention
    high │█
         │█▆                      ← weak open: title slide + "hi, I'm…"
         │█ ▆▅▄▃▂▁                   curve decays, room drifts
         │█        ▁▂▃ ...slow climb if you ever get to the demo
    low  └────────────────────────────► time
         0:00     0:30      1:00

    high │█▇▇▇▇▇▇▇▇▇▇▇▇▇▇          ← strong open: app answering on screen
         │█              ▇▇▇▇▇▇      one-liner lands while attention is high
         │█                          room is INVESTED before the demo proper
    low  └────────────────────────────► time
         0:00     0:30      1:00

    the strong open keeps the curve high through the handoff to 02
```

Hold that curve in mind: the screen should show buffr working before you finish your first sentence. Now here is the choreography.

## The body — the two beats in order

### Beat 1 — the hook (0:00–0:35): open on it working

The terminal is already up with `npm run chat` running. You do not boot it on stage — it is warm, the conversation is live, the cursor is blinking. Your first action is to ask a question grounded in your indexed corpus, and let Gemma answer it grounded and cited while you talk.

```
  SHOW (on screen)                 SAY (out loud)
  ───────────────────────────      ─────────────────────────────────
  chat REPL, cursor blinking       "This is running entirely on my
                                    laptop — no cloud, no API key."

  type a known-good question,      "Watch — I ask it something only
  e.g. about your stack/work       my own notes know the answer to…"
  → press enter

  the spinner, then a grounded,    "…and it answers from my docs,
  cited answer streams in          grounded, with the source."  ← hook lands
```

Notice the SAY track never says "now I'm typing a question." It speaks the *value* — local, grounded, yours — while your hands do the typing. That separation is the whole discipline: narrate the meaning, not the mechanics.

### Beat 2 — the one-liner (0:35–1:00): name what it is

The answer is on screen. Now, and only now, you name the thing. One sentence, said with your chest, close to verbatim:

```
┃ "buffr is a personal RAG agent that runs entirely on my own
┃  laptop — it knows me from a stored profile, and it remembers
┃  me across sessions, because I built it on my own AI toolkit."
```

Then the bridge into the demo — one line, and you move:

```
┃ "Let me show you the part that surprised me."
```

That sentence is doing real work: it promises a payoff and pulls the room toward the money shot. Don't explain what's coming. Promise it and go.

## Strong vs weak — the open

The contrast here is the most common single failure in hackathon demos. Put it where your eye catches it on stage.

```
  WEAK OPEN                          STRONG OPEN
  ─────────────────────────────      ─────────────────────────────────
  "Hi, I'm Rein. So, the problem     app is already answering a real
   with AI assistants is that         question, grounded and cited,
   they don't really know you,         before you finish sentence one
   and privacy is a concern, and…"
                                      one-liner lands AFTER the room has
  three slides before anything        seen it work — "buffr is a personal
  runs; attention already gone        RAG agent that runs on my laptop…"

  → room waits for proof             → room already has proof, now leans in
```

## The IF-IT-BREAKS box

The cold open is live, so it can fail live. The risk is real and named: stock Gemma's tool-calling is *emulated*, so it can occasionally skip the search tool and answer ungrounded. If your hook question whiffs, you do not freeze and you do not re-type it twice.

```
╔══════════════════════════════════════════════════════════════════╗
║ IF IT BREAKS — the cold-open question whiffs (ungrounded answer)  ║
║                                                                   ║
║ Gemma answered without citing a doc → DON'T re-ask the same Q.   ║
║ Say: "let me ask that a sharper way" and fire your KNOWN-GOOD    ║
║ question (the one you verified pre-flight cites a source). The    ║
║ retry reads as confidence, not a stumble.                         ║
║                                                                   ║
║ Total whiff (no terminal, app won't start) → cut to the 20-sec   ║
║ recorded clip. Say: "here it is from a run a minute ago" and      ║
║ keep the energy up. Never apologize twice. Keep moving.           ║
╚══════════════════════════════════════════════════════════════════╝
```

## The "tighten it" treatment

If you are already behind before you start (a previous presenter ran over, the slot got cut), compress the cold open to a single beat.

```
  TIGHTEN IT
    drop:  the spoken framing in Beat 1 — just ask the question,
           let the grounded answer appear, then say the one-liner.
    floor: the room must SEE one grounded answer + hear the one-liner.
           Never cut below "app working on screen + one sentence of
           what it is." That's the minimum cold open.
```

## The one-page run sheet — COLD OPEN

```
  ┌─ RUN SHEET · 01 COLD OPEN · 0:00–1:00 ─────────────────────────┐
  │                                                                 │
  │  GOAL: app answering on screen + one-liner, before 1:00         │
  │                                                                 │
  │  SAY, in order:                                                 │
  │   • "running entirely on my laptop — no cloud, no API key"      │
  │   • "watch — something only my own notes know…" (type the Q)    │
  │   • "…answers from my docs, grounded, with the source"          │
  │                                                                 │
  │  THE LINE TO NAIL:                                              │
  │   "buffr is a personal RAG agent that runs entirely on my own   │
  │    laptop — it knows me, and it remembers me across sessions."  │
  │   then: "Let me show you the part that surprised me."           │
  │                                                                 │
  │  IF IT BREAKS: ungrounded answer → fire the known-good Q.       │
  │                no app → 20-sec recorded clip. Never apologize 2x.│
  │                                                                 │
  │  TIGHTEN: skip Beat-1 framing; floor = one grounded answer +    │
  │           the one-liner.                                        │
  └─────────────────────────────────────────────────────────────────┘
```
