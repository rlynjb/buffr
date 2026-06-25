# Chapter 05 — The Close + The Ask   (8:45–9:30, 45 seconds)

## Opening hook

Forty-five seconds to land the plane — and the single most common way demos fumble the ending is trailing off into "yeah, so… that's it, I guess." Don't do that. You end on a beat: a clear future, a clear ask, and one sentence you want the room repeating to each other on the way out. The room remembers the first thing they saw and the last thing they heard. The first was the money shot. Make the last one count.

The discipline of the close is restraint. You do not demo the future — you *frame* it, clearly marked as future, never shown as if it exists. buffr today is single-device, single-conversation memory across sessions, emulated tools. The honest "what's next" is the in-prompt turn history that's still missing, and a native-tool model to harden the fragile seam. Name those as the road ahead, not as features you're hiding. Then ask for the one thing you actually want, and drop your last line.

## The time-budget bar

You own forty-five seconds, then thirty seconds of buffer to the buzzer. End early, on a beat.

```
  ┌──────────────────────────────────────────────────────────┐
  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓░░░░░░░░░░░░ │
  │ 0:00                       8:45 ─ 9:30 ──── 10:00         │
  │        THE CLOSE — you own 8:45 to 9:30 (45 sec)           │
  │        then 0:30 buffer — finish EARLY, not at the buzzer  │
  └──────────────────────────────────────────────────────────┘
```

## The chapter-opening diagram — now vs next, clearly separated

This is the picture that keeps you honest: what's real today on the left, what's framed as future on the right. You point at the left as "this is what you just saw," the right as "this is where it goes." Never blur the line.

```
  NOW (demoed, real) │ NEXT (framed as future — NOT demoed)
  ───────────────────┼─────────────────────────────────────────
  local RAG, grounded│ in-prompt turn history (sequential context
  + cited            │   within a session — still missing today)
                     │
  recall across      │ a native tool-calling model to harden the
  sessions (★ shown) │   emulated-tools seam (a provider swap)
                     │
  knows me (profile) │ multi-device sync (today it's single-device)
                     │
  all local, my data │ RLS / multi-user (no RLS this phase)
  ───────────────────┴─────────────────────────────────────────
   point LEFT: "you saw this"   point RIGHT: "this is where it goes"
```

Everything on the right is in the codebase's own honest backlog — the in-prompt history gap is documented in `src/session.ts`, the single-device and no-RLS constraints in the project context. You're not inventing a roadmap; you're reading the real one.

## The body — the beats in order

### Beat 1 — the vision, framed as future (8:45–9:05)

One sentence of where it goes. Marked as future, not demoed.

```
┃ "Today buffr is single-device and remembers across sessions.
┃  Next is sequential turn-history inside a session, a native-tool
┃  model to harden that emulated seam, and multi-device sync — so
┃  your agent follows you, still fully yours."
```

### Beat 2 — the ask (9:05–9:20)

Ask for one concrete thing. At a hackathon that's usually a vote, or a specific conversation. Be direct — a vague "let me know what you think" gets nothing.

```
┃ "What I want from you: if a personal AI that runs on YOUR machine
┃  and remembers YOU — without sending your life to someone's cloud —
┃  is worth building, tell me. That's the bet I'm making."
```

### Beat 3 — the last line (9:20–9:30)

The sentence you want them repeating. Short, concrete, and it ties the whole demo together — knows you, remembers you, all yours.

```
┃ "An AI that knows me, remembers me, and never leaves my laptop.
┃  That's buffr."
```

Then stop. Hands down, eyes up, done. Do not add "so, yeah." The silence after a clean last line is the strongest beat in the whole slot.

## Strong vs weak — the close

```
  WEAK CLOSE                         STRONG CLOSE
  ─────────────────────────────      ─────────────────────────────────
  "there's a lot more we could       "next is turn-history, a native-tool
   do, like maybe sync and stuff,     model, and sync — fully yours."
   the possibilities are endless"      (specific, real, framed as future)

  "anyway let me know what you        "if a personal AI that runs on YOUR
   think, thanks" (no real ask)        machine is worth building, tell me"

  trails off, looks at the screen     ends on the last line, eyes up,
                                       then SILENCE
  → forgettable                       → repeatable
```

## The IF-IT-BREAKS box

The only thing that breaks in the close is the clock — you arriving here with no time, or with too much.

```
╔══════════════════════════════════════════════════════════════════╗
║ IF IT BREAKS — the clock is against you                          ║
║                                                                   ║
║ Almost out of time → skip Beats 1 and 2 entirely. Say ONLY the   ║
║ last line: "An AI that knows me, remembers me, and never leaves   ║
║ my laptop. That's buffr." A clean last line with no vision/ask    ║
║ beats a rushed full close.                                        ║
║                                                                   ║
║ Way ahead of the clock → do NOT pad. Land the last line, stop,    ║
║ and take questions early. Finishing at 9:00 with a clean close    ║
║ reads as control. Talking until 10:00 reads as no edit.           ║
╚══════════════════════════════════════════════════════════════════╝
```

## The "tighten it" treatment

```
  TIGHTEN IT
    cut:    Beat 1 (the vision) — the future can wait for Q&A.
            Compress the ask into the last line's setup.
    keep:   the ask (one sentence) + the last line.
    floor:  the last line is non-negotiable — "knows me, remembers me,
            never leaves my laptop. That's buffr." End on the beat. A
            demo that ends on its last line is remembered; one that
            trails off is not.
```

## The one-page run sheet — THE CLOSE

```
  ┌─ RUN SHEET · 05 THE CLOSE · 8:45–9:30 (then 0:30 buffer) ───────┐
  │                                                                 │
  │  GOAL: vision (future) → ask → last line → SILENCE. Finish early│
  │                                                                 │
  │  SAY, in order:                                                 │
  │   1. VISION (future, not demoed): "next is turn-history inside  │
  │       a session, a native-tool model, and multi-device sync —  │
  │       still fully yours"                                        │
  │   2. ASK: "if a personal AI that runs on YOUR machine and       │
  │       remembers YOU is worth building, tell me"                │
  │   3. LAST LINE (nail it): "An AI that knows me, remembers me,   │
  │       and never leaves my laptop. That's buffr." → STOP        │
  │                                                                 │
  │  IF NO TIME: last line only.  IF AHEAD: land it, stop, take Q&A.│
  │  TIGHTEN: ask + last line only. Floor = the last line, clean.   │
  └─────────────────────────────────────────────────────────────────┘
```
