# Chapter 01 — The cold open   (0:00–1:00, 60 seconds)

## Opening hook

You have sixty seconds, and the room decides inside the first fifteen whether this is real or a slide deck. Do not introduce yourself. Do not say "so, our project is about personal AI assistants and we were thinking about privacy." The clock is running and you just spent your opening on throat-clearing. Open on the thing working: your laptop, the chat already up, a question already typed, and an answer that comes back grounded and cited. The room sees a real system respond before they've heard a single sentence of pitch.

The job of this minute is narrow: get one real answer on screen, then drop the one-liner that tells them what they just watched. That's it. The wow isn't here yet — the wow is the money shot at 2:30. This minute buys you the room's attention so they're still watching when it lands.

## The time-budget bar

You own the first sixty seconds. Get a live, cited answer on screen and say the one-liner — nothing else.

```
  ┌──────────────────────────────────────────────────────┐
  │ ▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
  │ 0:00 ─ 1:00 ──────────────────────────────────── 10:00 │
  │        THE COLD OPEN — you own 0:00 to 1:00 (60 sec)   │
  └──────────────────────────────────────────────────────┘
```

## The attention curve — what you're managing

The room's attention is highest at second zero and falls fast unless something holds it. This is the curve you're presenting into. Open cold on a working answer and you catch attention while it's still high; open on a self-intro and you spend it.

```
  the room's attention over the cold open

  high │█                                    ★ money shot
       │█▓                                     (ch 02, 2:30)
       │█▓▓░                                      ▲
  attn │█▓▓▓░░░          live answer lands         │
       │█▓▓▓▓▓░░░░░  ──► holds the line ──────────►│
       │█▓▓▓▓▓▓▓▓▓▓░░░  one-liner reframes it
  low  └────────────────────────────────────────────────
       0:00      0:30      1:00 ───────────► toward the demo

   you OPEN at peak attention. don't waste it on "hi, we're team X."
```

The trap is the slow on-ramp. Here's the move you make instead, side by side.

```
  WEAK cold open                  STRONG cold open
  ──────────────────────────      ──────────────────────────────
  "Hi, I'm Rein. So personal      [chat already open, question
   AI is a big space and we        already typed, you hit enter]
   wanted to explore memory       "Watch this — I ask my own
   and privacy, so we built…"       notes a question, on my
                                    laptop, no cloud."
  → 30 sec gone, nothing shown    → an answer is on screen by 0:15
```

## The body — the two beats

### Beat 1 — the hook (0:00–0:30): a live, cited answer

The chat is already running (`npm run chat`, started before you walked up — see the pre-flight in the overview). The question is pre-typed in the input. You hit enter and talk over the spinner while Gemma answers.

```
  SHOW (on screen)                    SAY (out loud)
  ────────────────────────────────    ─────────────────────────────────
  npm run chat already open,          "This is running on my laptop
  cursor in the input, question        right now — my model, my data,
  pre-typed                            no API key, nothing leaves the
                                       machine."
  ── you hit enter ──                  (let it think; don't narrate the
  the dots spinner: "thinking…"        spinner)
  the answer prints — grounded in      "And there's the answer — pulled
  your indexed notes, with a           straight from my own notes, and
  citation to the source doc           it tells me where it got it."  ◄ hook lands
```

Do not read the whole answer aloud. The room can read. You point at the citation — the fact that it grounded the answer in a real source doc — and move.

### Beat 2 — the one-liner (0:30–1:00)

Now that they've seen it work, tell them what it is. One sentence, said slowly, then a half-beat of silence so it sits.

```
┃ "buffr is a personal AI agent that knows me and remembers me —
┃  running entirely on my own laptop, on my own database."
```

That's the one-liner: *X is a Y that does Z for W.* buffr (X) is a personal AI agent (Y) that knows you and remembers you, self-hosted (Z), for you, the person whose data it is (W). Say it close to verbatim. It's the sentence you want a judge repeating to another judge in the hallway.

Then the bridge into the demo — short, forward-leaning:

```
┃ "Let me show you the part that made me sit up — it remembers
┃  a conversation we had earlier."
```

That line is a promise. It tells the room the money shot is coming and tells them what to watch for, so when it lands at 2:30 they recognize it instead of missing it.

## The IF-IT-BREAKS box

The hook beat is the riskiest sixty seconds in the whole demo, because it's live and it's first. The most likely failure is the one the build honestly has: Gemma's tool-calling is emulated, so it can occasionally skip the search tool and answer ungrounded — no citation. Have a known-good question ready, and a clip behind that.

```
╔══════════════════════════════════════════════════════════════════╗
║ IF IT BREAKS                                                       ║
║                                                                    ║
║ Answer comes back ungrounded / no citation (Gemma skipped the     ║
║ search tool) → stay calm, retype your KNOWN-GOOD question (the     ║
║ one you verified in pre-flight) and re-ask. Say: "let me ask       ║
║ that more directly." The retry almost always grounds.             ║
║                                                                    ║
║ Two misses in a row, OR chat won't start → switch to the          ║
║ 25-second recorded clip. Say: "here it is from a run a few         ║
║ minutes ago" and keep the energy up. Never apologize twice.       ║
╚══════════════════════════════════════════════════════════════════╝
```

## The "tighten it" cut

If the slot is shorter than ten minutes, the cold open compresses but never disappears — you always open on the thing working. The cut: **drop the bridge line into the demo** (the "made me sit up" promise) and go straight from the one-liner to the first demo beat. The floor you must not cut below: one live cited answer on screen plus the one-liner. If you cut the live answer, you've cut the cold open's whole reason to exist.

## The one-page run sheet — CHAPTER 01

```
  ┌─ COLD OPEN ─ 0:00–1:00 ─ 60 sec ────────────────────────────┐
  │                                                              │
  │  PRE-FLIGHT DONE: chat open, question pre-typed, corpus      │
  │  indexed, clip ready.                                        │
  │                                                              │
  │  BEAT 1 (0:00–0:30) — hit enter on the pre-typed question    │
  │    SAY: "running on my laptop — my model, my data, no cloud" │
  │    SAY (on answer): "pulled from my own notes — and it cites │
  │         where it got it"                                     │
  │                                                              │
  │  BEAT 2 (0:30–1:00) — the one-liner, said slowly:            │
  │    ┃ "buffr is a personal AI agent that knows me and          │
  │    ┃  remembers me — on my own laptop, my own database."      │
  │    bridge: "let me show you the part that made me sit up —   │
  │             it remembers a conversation we had earlier."     │
  │                                                              │
  │  NAIL THIS LINE: the one-liner.                              │
  │  IF IT BREAKS: re-ask known-good Q once → else 25-sec clip.  │
  │  TIGHTEN: drop the bridge line. Floor: one live cited answer │
  │           + the one-liner.                                   │
  └──────────────────────────────────────────────────────────────┘
```

On to chapter 02 — the demo, and the money shot.
