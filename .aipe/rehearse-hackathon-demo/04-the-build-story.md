# Chapter 04 — The Build Story   (8:00–8:45, 45 seconds)

## Opening hook

Forty-five seconds to prove this is a real build, not a pitch deck with a happy-path screen recording. The judges have seen a hundred demos that fall apart the moment you ask "is this actually working?" — and the ones that win answer that question *before* it's asked, by naming the genuine hard part and how they cracked it. You have a real hard part, and it's the most interesting thing about the build: **you're running stock `gemma2:9b`, which has no native tool-calling at all.** You made an agent that uses tools out of a model that can't call tools. That's the story.

The move here is not to hide the rough edge — it's to own it with the confidence of someone who shipped under a clock. The tool-calling is *emulated*: the system prompt teaches Gemma the tool schema in prose, and a forgiving parser reads a JSON object back out of free text, with one corrective retry. It's the most fragile seam in the system and you know exactly where it lives. Naming that is the strongest possible signal that you built this and understand it — far stronger than pretending it's bulletproof.

## The time-budget bar

You own forty-five seconds. Name what shipped, name the hard part, then move to the close.

```
  ┌──────────────────────────────────────────────────────────┐
  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓░░░░░░░░░░░░░░░ │
  │ 0:00                  8:00 ─ 8:45 ──────────────── 10:00  │
  │        THE BUILD STORY — you own 8:00 to 8:45 (45 sec)     │
  └──────────────────────────────────────────────────────────┘
```

## The chapter-opening diagram — the hard part, in one picture

This is the obstacle and the crack, drawn once. The loop expects a model that can request a tool. Gemma can't. The provider is the adapter that fakes it in both directions.

```
  THE HARD PART — making a no-tools model use a tool

  ┌─ Agent loop ─────────────────────────────────────────────┐
  │  expects: a structured tool_use request from the model    │
  └───────────────────────────┬──────────────────────────────┘
                              │  but gemma2:9b has NO tool API
  ┌─ The emulation (the crack) ▼──────────────────────────────┐
  │  OUTBOUND: render the tool schema into the system prompt   │
  │            "respond with ONLY {tool, arguments}"           │
  │  INBOUND:  parse JSON back out of free text                │
  │            null? looks like a tool attempt? → retry once   │
  └───────────────────────────┬──────────────────────────────┘
                              │  plain text in, plain text out
  ┌─ Ollama: gemma2:9b ───────▼──────────────────────────────┐
  │  no tools parameter, no tool_use response — just text     │
  └───────────────────────────────────────────────────────────┘

  the contract is a prose instruction the model MAY follow;
  the only enforcement is the forgiving parser on the way back
```

That picture is the build story: an honest obstacle, a real mechanism, and a named fragility. Now say it in two sentences.

## The body — the beats in order

### Beat 1 — what shipped (8:00–8:20)

Name the real, working surface fast. You're not listing every file — you're proving the path runs end to end.

```
┃ "What's running here is real: a migration sets up the schema,
┃  I index a corpus into Postgres, and the chat surface retrieves,
┃  grounds, answers, and remembers — all of it on this laptop."
```

### Beat 2 — the hard part, owned (8:20–8:45)

Now the genuine obstacle, named without flinching. This is the sentence that separates you from the mockups:

```
┃ "The hard part: stock Gemma has no native tool-calling. So I
┃  emulate it — teach the tool schema in the prompt, parse the JSON
┃  back out, retry once if it drifts. It's the most fragile seam in
┃  the system, and I know exactly where it lives."
```

Then connect it to your track record — you've done on-device AI for real before, so this isn't your first local-model rodeo. One line, true, no overclaiming:

```
┃ "I've shipped on-device AI before — pose-tracking in contrl,
┃  Gemini Nano on-device in dryrun — so running the model local
┃  was the part I trusted; the tool emulation was the puzzle."
```

That reference is real and load-bearing: it tells the room the local-AI instinct is earned, not improvised for a hackathon. And the RAG fundamentals trace back to AdvntrCue (pgvector, GPT-4, tool-calling, session memory) — buffr is the local-first, self-hosted evolution of a shape you've already shipped in the cloud.

## Strong vs weak — the build story

```
  WEAK BUILD STORY                   STRONG BUILD STORY
  ─────────────────────────────      ─────────────────────────────────
  "it all works great, super         "the hard part: Gemma has no native
   smooth, no issues" — then a         tool-calling, so I emulate it and
   judge finds the rough edge and      retry once if it drifts. It's the
   the whole thing wobbles             most fragile seam — here's where"

  hides the emulation; hopes          owns the emulation; names the
  nobody asks                          fragility before anyone asks

  → looks like a mockup that          → looks like an engineer who built
     might be faked                       it, shipped under a clock, and
                                          knows exactly what's load-bearing
```

## The IF-IT-BREAKS box

No live app beat here — it's two diagrams and four sentences. The only thing that breaks is overrunning into territory that belongs in the Q&A.

```
╔══════════════════════════════════════════════════════════════════╗
║ IF IT BREAKS — a judge interrupts with "so it's not reliable?"   ║
║                                                                   ║
║ Don't get defensive. Say: "for a stock local model, it's a known ║
║ tradeoff — I accept some fragility to run fully local and free.  ║
║ A native-tool model would remove it; that's a swap, not a rebuild,║
║ because of the provider seam." Then move to the close. The full   ║
║ answer is loaded in Chapter 06 — don't spend the clock on it now. ║
╚══════════════════════════════════════════════════════════════════╝
```

## The "tighten it" treatment

This is already 45 seconds. If you're behind, drop to the single hard-part sentence.

```
  TIGHTEN IT
    cut:    Beat 1 (what shipped) — the demo already proved it runs.
            And the contrl/dryrun/AdvntrCue track-record line.
    keep:   the hard-part sentence only — "Gemma has no native tools,
            so I emulate them and retry once; it's the fragile seam."
    floor:  the room must hear ONE genuine hard part owned honestly.
            That's what makes the build real. Don't cut below it.
```

## The one-page run sheet — THE BUILD STORY

```
  ┌─ RUN SHEET · 04 BUILD STORY · 8:00–8:45 ───────────────────────┐
  │                                                                 │
  │  GOAL: prove it's real + own the hard part, in 45 sec          │
  │                                                                 │
  │  SAY, in order:                                                 │
  │   1. "migration → index a corpus → chat retrieves, grounds,    │
  │       answers, remembers — all on this laptop"                 │
  │   2. THE HARD PART: "stock Gemma has no native tool-calling,   │
  │       so I emulate it — schema in the prompt, parse JSON back, │
  │       retry once. Most fragile seam, I know where it lives."   │
  │   3. "I've shipped on-device AI before (contrl, dryrun) — the  │
  │       local model I trusted; the tool emulation was the puzzle"│
  │                                                                 │
  │  IF CHALLENGED ("not reliable?"): "known tradeoff for a stock  │
  │   local model — fragility for fully-local + free. Native-tool  │
  │   model is a swap not a rebuild." Then move on.                │
  │                                                                 │
  │  TIGHTEN: hard-part sentence only. Floor = one real hard part. │
  └─────────────────────────────────────────────────────────────────┘
```
