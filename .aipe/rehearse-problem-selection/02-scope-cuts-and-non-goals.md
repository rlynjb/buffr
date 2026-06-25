# Chapter 2 — Scope Cuts and Non-Goals

Here's the counterintuitive part: the strongest signal in this whole project isn't what you built. It's what you *refused* to build. Anyone can sprawl a personal project into a half-finished platform — the phone brain, the sync layer, the multi-platform gateway, fine-tuning, all stubbed, none working. What's rare, and what reads as senior, is the discipline to ship **one agent end-to-end with measured numbers** and consciously defer everything else behind a named door. Scope discipline is the thing junior engineers can't fake, because faking it means *not building* the shiny stuff, and the pull to build the shiny stuff is exactly what they can't resist.

```
  THE SCOPE LINE — what's in, what's deferred behind a door

  ┌─ IN SCOPE (v1b — built and verified) ─────────────────┐
  │  ONE agent, end to end, single device:                │
  │   • Gemma provider + tool-call emulation              │
  │   • RAG pipeline (chunk→embed→pgvector→search→rank)   │
  │   • centralized agents schema, app_id-keyed           │
  │   • trajectory capture (every turn → messages)        │
  │   • precision@k / recall@k evals                      │
  └────────────────────────┬───────────────────────────────┘
                           │  HARD LINE — drawn deliberately
  ┌─ DEFERRED (named, not built — one-way doors) ─────────▼─┐
  │   • the phone brain (RN, on-device model)             │
  │   • laptop↔phone memory sync/merge                    │
  │   • the multi-platform gateway (Telegram, etc.)       │
  │   • Edge Functions / HTTP API · RLS policies          │
  │   • trajectory → fine-tune (the ceiling)              │
  └────────────────────────────────────────────────────────┘
```

The line is the chapter. Everything below the line was deferred *on purpose*, with a reason, and the reasons are the senior signal.

## The biggest cut: the two-brain body

  ┌─────────────────────────────────────────────────────────┐
  │ THEY ASK                                                 │
  │   "Your design talks about a laptop brain and a phone    │
  │    brain. Why didn't you build the phone?"              │
  │                                                         │
  │ WHAT THEY'RE TESTING                                     │
  │   Do you defer to avoid hard work, or to avoid a         │
  │   one-way door? The first is laziness; the second is     │
  │   judgment. They want to see you name the door.         │
  └─────────────────────────────────────────────────────────┘

The two-brain body — laptop with full Gemma, phone with an on-device Gemini-Nano-class model, both sharing one memory plane in Supabase — is in the design doc as a *deferred* decision, on purpose. Your own spec says it: *"build the parts first, get them real and hand-tested in isolation, then decide the body. This dodges the one-way doors."*

> "I deliberately deferred the phone brain, and the reason is one-way doors. The moment you have two brains sharing one memory, you have a sync-and-merge problem — which is the exact canonical-local-with-cloud-mirror pattern I already hit in buffr, and it's genuinely hard. My design says it explicitly: build the laptop brain first so the sync problem is the *second* thing I solve, not the first. If I'd started with two brains, I'd have spent all my time on conflict resolution and never proven the agent actually retrieves and answers well. So the cut wasn't 'the phone is too much work' — it was 'the phone forces a hard, irreversible decision before I've validated the easy, reversible part.'"

That's the distinction the interviewer is mining for. You didn't defer to dodge effort. You deferred to **sequence the one-way doors after the reversible work** — build the cheap, decision-independent pieces now, postpone the irreversible body decision until you have evidence to make it with.

```
  WHY DEFER THE BODY — sequence reversible before irreversible

  ┌─ reversible (build now) ──────────────────────────────┐
  │  the packages: provider, RAG, profile, evals, the     │
  │  laptop brain. Swap a vector store, swap an embedder  │
  │  (with reindex) — all changeable later.               │
  └───────────────────────────┬────────────────────────────┘
                              │  validate HERE first
  ┌─ irreversible (decide later) ─────▼────────────────────┐
  │  two-brain topology · sync/merge semantics · the       │
  │  gateway. Get these wrong and you rebuild. So you      │
  │  wait until you have evidence to decide them right.    │
  └────────────────────────────────────────────────────────┘
```

  ┃ "I didn't defer the phone because it's hard. I
  ┃  deferred it because it forces an irreversible
  ┃  decision before I've validated the reversible part."

## The cut that's also an architecture decision: centralize the agent, not the data

  ┌─────────────────────────────────────────────────────────┐
  │ THEY ASK                                                 │
  │   "You said it centralizes data across your apps —       │
  │    so you migrated all your apps into one schema?"      │
  │                                                         │
  │ WHAT THEY'RE TESTING                                     │
  │   Did you understand the difference between centralizing │
  │   data (a migration nightmare, tight coupling) and       │
  │   centralizing the agent layer (a clean boundary)?      │
  └─────────────────────────────────────────────────────────┘

This is a scope cut disguised as an architecture choice, and it's one of the sharpest decisions in the whole plan. The naive version of "a personal agent that centralizes my data" is: pull every app's data into one schema. That's a disaster — you'd be rewriting every app's storage and coupling them all to the agent. You cut that explicitly. Your plan says it in bold: *"Centralize the agent layer, not the data. Existing per-app schemas stay where they are."*

> "I'm centralizing the *agent layer*, not the *data*. Every app keeps its own schema, untouched. The new `agents` schema holds only RAG infrastructure — corpus copies, chunks, conversations, the trajectory log — and apps write *into* it with their own `app_id` when they want something indexed. They never touch each other's tables and they never touch the agent's internals; the only contract is 'write a document with your app_id.' That's the whole point of the cut: centralizing the data would mean migrating and coupling every app, which is exactly the kind of irreversible, sprawling work I refused to take on. Centralizing only the agent layer keeps every app independent and keeps the boundary clean."

The senior signal here is that you saw the *cheap, wrong* version (centralize the data) and the *expensive-looking but correct* version (centralize only the agent layer) and chose correctly — and can articulate *why* the cheap version is a trap. (The full architecture walk lives in `.aipe/study-system-design/04-library-as-dependency-boundary.md`; here it's the scope argument.)

## The cut that proves the discipline: one agent, not a platform

  ┌─────────────────────────────────────────────────────────┐
  │ THEY ASK                                                 │
  │   "AptKit ships five agents. Why didn't you build the    │
  │    fleet, the gateway, the whole platform?"             │
  │                                                         │
  │ WHAT THEY'RE TESTING                                     │
  │   Do you know that 'one thing that works, measured'      │
  │   beats 'five things stubbed'? This is the core scope-   │
  │   discipline test.                                      │
  └─────────────────────────────────────────────────────────┘

Your plan opens with this, in its own words: *"The deliverable is one good agent with measured eval numbers — not a platform."* And under "What NOT to do": *"Don't ship a platform before one good agent works end-to-end."*

> "AptKit's five packaged agents are templates, not the product. I built one — a RAG query agent — end to end, and measured it, because one agent with real eval numbers is worth more than five stubbed agents and a gateway diagram. The whole thesis of the project is *measured evidence*: precision@5, faithfulness, JSON validity. You can't measure a platform you haven't finished. So the scope discipline isn't a limitation I'm apologizing for — it's the design. Ship one, measure it, then maybe generalize. The Phase 4 one-pager with the actual numbers is the deliverable; a half-built fleet would have no numbers at all."

  ┃ "One agent with real eval numbers beats five stubbed
  ┃  agents with a gateway diagram. You can't measure a
  ┃  platform you never finished."

## The non-goals, named honestly

These are in your design doc's "Out of scope" and "What NOT to do" lists. Naming them *as deliberate non-goals* — not as "things I didn't get to" — is the move:

| Non-goal | Why it's cut (in your words) |
|----------|------------------------------|
| Edge Functions / HTTP API | "Single device has one client; HTTP API is YAGNI until phone/app #2." Direct `pg` now. |
| RLS policies | "RLS unneeded for one user." Gated on app #2 writing — and named as a hard prerequisite before then. |
| `agents.tool_runs` cache | "YAGNI for a single device." |
| Fine-tuning | "The ceiling, and only after Phase 4 evidence demands it. Never pre-train." |
| Multi-platform gateway | Deferred with the body; needs the topology decided first. |

Notice every "cut" comes with a *reason* and, where it matters, a *re-entry condition* — RLS is gated on "a second app writes," fine-tuning is gated on "Phase 4 evidence." That's the difference between a deferral and an abandonment. A deferral has a trigger. An abandonment is just "I gave up." You only have deferrals.

## When you're cornered

  ╔═════════════════════════════════════════════════════════╗
  ║ IF THEY SAY                                              ║
  ║   "So you basically built a small single-device RAG app  ║
  ║    and called it a personal agent platform."            ║
  ║                                                         ║
  ║ DON'T                                                    ║
  ║   Get defensive or oversell the deferred parts as if     ║
  ║   they're almost done. They're not built. Own it.       ║
  ║                                                         ║
  ║ DO                                                       ║
  ║   "Yes — and that's the point. I built the smallest      ║
  ║    thing that validates the premise: one agent that      ║
  ║    retrieves and answers from my own corpus, measured.   ║
  ║    The platform framing is the *roadmap*, and every      ║
  ║    deferred piece is named with a re-entry condition —   ║
  ║    RLS when app #2 writes, the phone after the laptop    ║
  ║    brain is validated, fine-tuning only if Phase 4       ║
  ║    numbers demand it. I'd rather ship one validated      ║
  ║    slice with a clear roadmap than five broken pieces.   ║
  ║    The restraint is the senior skill, not the gap."     ║
  ╚═════════════════════════════════════════════════════════╝

## The one-page version

**Core claim:** The scope is one agent, end to end, single device, with measured evals — and everything else is deferred behind a named door with a re-entry condition. The restraint is the signal: you cut the two-brain body to sequence reversible work before the irreversible sync decision, you centralize the *agent layer* not the data to keep every app independent, and you ship one measured agent instead of a stubbed platform.

**The questions, one-line answers:**
- "Why no phone?" → It forces an irreversible sync decision before I've validated the reversible parts. Laptop first.
- "You centralized all your data?" → No — only the *agent layer*. Apps keep their schemas; they write in with an app_id.
- "Why one agent, not the platform?" → One agent with real numbers beats five stubbed. The measured one-pager is the deliverable.
- "Isn't it just a small RAG app?" → Yes, deliberately — the smallest thing that validates the premise, with a named roadmap.

**The pull quote you keep:** *"I didn't defer the phone because it's hard. I deferred it because it forces an irreversible decision before I've validated the reversible part."*

→ Next: Chapter 3, options and opportunity cost. The scope is justified — now the crux question: why build *any* of it instead of installing Hermes?
