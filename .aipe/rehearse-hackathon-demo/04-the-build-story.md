# Chapter 04 — The build story   (8:00–8:45, 45 seconds)

## Opening hook

Forty-five seconds to prove this is a working build, not a mockup, and to show you cracked one genuinely hard thing. The temptation is to list every feature you shipped. Don't — you don't have the time and the room doesn't care about the feature count. Name what actually shipped in one breath, then spend the rest on the *one hard part* and how you got it to work. The hard part is the proof: anyone can paste a UI together; cracking a real problem under a clock is the signal that you built the thing.

For buffr the honest hard part is the best part of the story, because it's where you own a rough edge with confidence. Gemma — the local model you're running — has no native tool-calling. So the agent loop needs the model to call a search tool, and the stock model literally can't, the way Anthropic's or OpenAI's API can. The crack was making tool-calling work anyway, on an emulated path, and then choreographing the demo around the failure mode it leaves. That's a real engineering story and you tell it straight.

## The time-budget bar

You own 8:00 to 8:45. One breath on what shipped, the rest on the one hard part — then move.

```
  ┌──────────────────────────────────────────────────────┐
  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓░░░░░░░░░░░░ │
  │ 8:00 ─ 8:45 ──────────────────────────────────────── 10:00 │
  │       THE BUILD STORY — you own 8:00 to 8:45 (45 sec) │
  └──────────────────────────────────────────────────────┘
```

## The chapter-opening diagram — what shipped, and the one hard part

The visual is a quick inventory with the hard part flagged. You don't read it out — it's the shape behind your forty-five seconds.

```
  WHAT SHIPPED — and the crack

  ┌─ shipped, working on the happy path ──────────────────────────┐
  │  npm run migrate   transactional schema runner                │
  │  npm run index     embed a corpus into pgvector (768-dim)     │
  │  npm run chat      long-lived Ink session, one conversation   │
  │  npm run eval      precision@k / recall@k over the retrieval  │
  │  + retrieval-based memory across sessions (the money shot)    │
  └───────────────────────────────────────────────────────────────┘

  ┌─ THE HARD PART ★ ─────────────────────────────────────────────┐
  │  Gemma (gemma2:9b) has NO native tool-calling.                │
  │  The agent loop needs a tool call out of the model.           │
  │  → aptkit EMULATES it: render the tool schema into the prompt,│
  │    parse a JSON tool-call back out of free text.              │
  │  → cost owned honestly: it can occasionally skip the tool and │
  │    answer ungrounded. The demo is choreographed around that.  │
  └───────────────────────────────────────────────────────────────┘
```

## The body — the two beats

### Beat 1 — what shipped (8:00–8:15): one breath

Say it fast, as a single list, so the room registers "this is a real, runnable system" and you move on.

```
┃ "This actually runs: one command migrates the schema, one indexes
┃  a corpus, one opens the chat, one scores the retrieval. And on top,
┃  cross-session memory — the thing you just saw."
```

You're naming the four scripts (`migrate`, `index`, `chat`, `eval` — all real in `package.json`) plus the memory feature. That's the "it's real" proof in fifteen seconds. Resist adding more.

### Beat 2 — the one hard part (8:15–8:45): the emulated tool-calling crack

This is the story. Tell it as a problem you hit and solved, and own the rough edge in the same breath — that's what confidence under a clock looks like.

```
  SHOW (on screen / slide)            SAY (out loud)
  ────────────────────────────────    ─────────────────────────────────
  the "hard part" box from the        "The hard part: I'm running a
  diagram                              local model, Gemma, that has no
                                       native tool-calling — it can't
                                       call my search tool the way a
                                       cloud API can."
  (no live action — you're telling     "So tool-calling is emulated — the
   a story)                            schema goes into the prompt, and I
                                       parse the model's reply back into a
                                       tool call. It works."
                                       "The honest rough edge: sometimes
                                       it skips the tool and answers
                                       ungrounded. So I built the demo to
                                       recover from exactly that — re-ask,
                                       and it grounds."
```

That last line does double duty: it owns the limitation *and* it explains why your demo had a recovery built in. You're not hiding the rough edge — you're showing you engineered around it on purpose. That reads as someone who shipped under a clock and knew exactly where the bodies were buried.

```
┃ "I knew tool-calling was the weak seam, so I built the demo to
┃  recover from it. That's the difference between a build and a slide."
```

Here's the contrast, because the apologetic version of this story is the failure mode.

```
  WEAK build story                    STRONG build story
  ──────────────────────────────      ──────────────────────────────────
  "Unfortunately Gemma doesn't        "Gemma has no native tool-calling,
   really support tools so it's        so I emulated it — and choreographed
   a bit unreliable, sorry, it         the demo around the one failure
   mostly works though…"               mode it leaves. It's a known seam,
                                       not a surprise."
  → sounds like an excuse             → sounds like an engineer
```

This anchors to real, shipped work: on-device AI is your lane (dryrun runs Gemini Nano on-device; contrl runs MediaPipe on-device, no cloud). buffr is the local-first evolution — and you've shipped classic cloud RAG too (AdvntrCue, pgvector + GPT-4). If a judge asks "have you done this before," that's your answer: buffr composes the on-device thread and the RAG thread you've each shipped separately.

## The IF-IT-BREAKS box

No live beat here — it's a told story. The failure mode is a judge challenging the honesty mid-story ("so it's broken?"). Don't retreat.

```
╔══════════════════════════════════════════════════════════════════╗
║ IF IT BREAKS (challenged on the rough edge)                       ║
║                                                                    ║
║ "So it doesn't actually work reliably?" → "It works — the seam is  ║
║ the emulated tool-calling, which is a known property of running    ║
║ tools on a model with no native tool API. The fix is argument-     ║
║ schema validation on the parsed call; that's the next commit." Own ║
║ it, name the fix, don't flinch. (Detail: study-ai-engineering/     ║
║ 04-agents-and-tool-use/02-tool-calling.md.)                       ║
╚══════════════════════════════════════════════════════════════════╝
```

## The "tighten it" cut

Under a tight slot, cut beat 1 to a half-sentence ("it's four real commands plus the memory") and keep the hard-part story, because the hard part is the proof and the feature list isn't. The floor: the room hears *one* genuine engineering obstacle you cracked. If you cut the hard part, you've cut the only thing in this chapter that separates you from a pitch deck.

## The one-page run sheet — CHAPTER 04

```
  ┌─ BUILD STORY ─ 8:00–8:45 ─ 45 sec ──────────────────────────┐
  │                                                              │
  │  BEAT 1 (8:00–8:15) what shipped — one breath:               │
  │    ┃ "runs: migrate, index, chat, eval — plus cross-session  │
  │    ┃  memory."                                               │
  │                                                              │
  │  BEAT 2 (8:15–8:45) the hard part:                           │
  │    "Gemma has no native tool-calling → I emulated it →       │
  │     it can skip the tool → so I built the demo to recover."  │
  │    ┃ "I knew tool-calling was the weak seam, so I built the  │
  │    ┃  demo to recover from it. Build, not slide."            │
  │                                                              │
  │  NAIL THIS LINE: "build, not a slide."                       │
  │  IF CHALLENGED: "known seam — fix is arg-schema validation,  │
  │                  that's the next commit."                    │
  │  TIGHTEN: cut beat 1 to half a sentence. Floor: one real     │
  │           obstacle you cracked.                              │
  └──────────────────────────────────────────────────────────────┘
```

On to chapter 05 — the close.
