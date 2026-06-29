# Chapter 06 — The Q&A   (after the clock — prep only)

## Opening hook

This chapter never counts against your ten minutes. It runs *after* the timed slot, when a judge walks up or the panel asks "okay, a few questions." Which means your only job here is preparation: have a crisp, honest, speakable answer ready for the five questions judges always ask, plus a decision tree for the follow-ups. The demo made them feel it; the Q&A is where they test whether you actually built it and understand it. Candor wins this room. A judge in 2026 assumes you used AI tools heavily — defensiveness about it reads worse than just owning what the tools did and what you did.

The thread running through every answer below: you ground the claim in the codebase, you name the rough edge before they find it, and you point to where the depth lives if they want to go further. That posture — "here's what's real, here's the honest limit, here's the detail" — is what a senior engineer sounds like.

## The chapter-opening diagram — the five probes and where each goes

These are the five questions, and the one-word posture each one wants from you.

```
  THE FIVE STANDARD PROBES → the posture each wants

  ┌─ "Is this actually working?" ──────────► SHOW, don't claim
  │     re-run a live query, or the eval number
  │
  ├─ "What was the hard part?" ────────────► OWN the seam
  │     emulated tool-calling; the recovery you built
  │
  ├─ "What's the stack?" ──────────────────► NAME it precisely
  │     Gemma/Ollama + pgvector + aptkit, no vendor fog
  │
  ├─ "Did you build this in the window?" ──► CANDID on AI use
  │     what shipped, what aptkit gave you, what AI helped
  │
  └─ "Is there a business / what's next?" ─► HONEST future
        the privacy wedge, framed as direction not product
```

## The body — the five answers

### Probe 1 — "Is this actually working, or is it staged?"

Don't argue it's real — *show* it's real. You have two pieces of live proof: re-run a query in front of them, and the eval number.

```
  SAY (out loud)
  ─────────────────────────────────────────────────────────────────
  "Happy to — let me ask it something you pick."  [take their
  question, ask it live, let it answer grounded.]
  "And it's measured, not vibes — I have a precision-at-k eval over
  the retrieval. Let me run it."  [npm run eval — read the REAL
  number off the screen.]
```

```
╔══════════════════════════════════════════════════════════════════╗
║ NEVER FABRICATE THE EVAL NUMBER                                   ║
║                                                                    ║
║ Run `npm run eval` and read the actual P@1 / R@3 off the screen.  ║
║ It scores 3 labeled query→doc pairs (work.md / stack.md /          ║
║ coffee.md, eval/queries.json). Quote the number you SEE, today,    ║
║ on your corpus — never a number you remember or hoped for. A       ║
║ judge who catches one fabricated metric discards the whole demo.  ║
╚══════════════════════════════════════════════════════════════════╝
```

Follow-up tree:
- *"Can I pick a question it hasn't seen?"* → "Yes — go ahead." (This is the strongest possible proof; welcome it. If it answers ungrounded, own it: "that's the emulated-tool-calling seam — watch, I re-ask and it grounds.")
- *"How big is your eval set?"* → "Three labeled pairs right now — small and honest. It's a regression gate, not a benchmark. The next step is faithfulness scoring on the generation, not just retrieval." (Detail: `study-ai-engineering/05-evals-and-observability/02-eval-methods.md`.)

### Probe 2 — "What was the hard part?"

This is your chapter-04 story, told once more, tight. Lead with the seam.

```
  SAY (out loud)
  ─────────────────────────────────────────────────────────────────
  "Running tools on a local model with no native tool-calling. Gemma
  can't call a function the way a cloud API can, so aptkit emulates
  it — renders the tool schema into the prompt, parses the JSON
  tool-call back out. It works, but it can skip the tool and answer
  ungrounded. So I choreographed the demo to recover from exactly
  that. The next commit is argument-schema validation on the parsed
  call."
```

Follow-up tree:
- *"Why not use a model with native tools?"* → "Because the whole point is local and self-hosted — Gemma runs on my laptop with no cloud. Native tool-calling would mean an API and my data leaving the machine. I took the emulation cost to keep the privacy story." (That's an honest, deliberate tradeoff — name it without flinching.)
- *"How often does it skip the tool?"* → "Often enough that I built a re-ask recovery into the demo. I don't have a hard rate; that's exactly what the eval should grow to measure."

### Probe 3 — "What's the stack?"

Name it precisely. No vendor fog, no "we use a vector database." Real names, real versions.

```
  SAY (out loud)
  ─────────────────────────────────────────────────────────────────
  "TypeScript, ESM, Node 20. The model is gemma2:9b served by Ollama,
  embeddings are nomic-embed-text, 768 dimensions. Storage is Postgres
  with pgvector — an HNSW cosine index. The whole agent — the loop,
  the retrieval pipeline, the tools, the memory engine — comes from my
  own toolkit, aptkit, which buffr consumes as a library. The chat UI
  is Ink, React in the terminal."
```

Follow-up tree:
- *"What's aptkit?"* → "My own AI toolkit — the model-provider contract, the agent loop, retrieval, evals, and the conversation-memory engine. I actually extracted the memory engine *up* out of buffr into aptkit and re-consume it here. buffr is the app; aptkit is the substrate I built it on." (This is a strong signal — you built your own tools. Lean into it.)
- *"Why pgvector and not a dedicated vector DB?"* → "Because the relational data and the vectors live in one Postgres instance — one store, one index, one place to back up. For one device that's the right call; a dedicated vector DB would be infrastructure I don't need yet." (Detail: `study-system-design/01-vector-store-adapter.md`.)

### Probe 4 — "Did you actually build this in the hackathon window? How much was AI?"

Be matter-of-fact. Judges assume heavy AI use; candor reads as confidence, defensiveness as a tell.

```
  SAY (out loud)
  ─────────────────────────────────────────────────────────────────
  "Yes. The substrate — aptkit — I'd built before; buffr is the part
  that graduated an in-memory RAG pipeline to persistent pgvector and
  added the chat CLI and the cross-session memory wiring. I used AI
  coding tools throughout — the same way I'd use them at work. The
  architecture decisions, the schema, the choice to ride memory on the
  same store as documents — those are mine. The tools accelerated the
  typing, not the thinking."
```

Follow-up tree:
- *"So aptkit was pre-existing — isn't that cheating?"* → "It's the library I depend on, like depending on React. The hackathon work is buffr: the persistence layer, the session, the memory wiring, the CLIs. I'd rather be honest that I stood on my own toolkit than pretend I wrote a vector store from scratch this weekend."
- *"Which AI tools?"* → Name them plainly, no hedge. Then: "they wrote a lot of the boilerplate; the load-bearing decisions are in the design docs in `docs/superpowers/specs/`." (Honesty about process is the answer that lands.)

### Probe 5 — "Is there a business here? What's next?"

Frame the wedge honestly as a direction, not a product that exists. The privacy angle is the real one.

```
  SAY (out loud)
  ─────────────────────────────────────────────────────────────────
  "The wedge is privacy: a personal AI where your data and your model
  never leave your machine. That's a real and growing want — people
  don't want their second brain on someone else's server. Next steps
  are indexing real personal corpora end-to-end and hardening the
  tool-calling. I'm not claiming it's a company today — it's a working
  proof that local-first personal AI is buildable now."
```

Follow-up tree:
- *"Doesn't a cloud assistant just do this better?"* → "On raw capability, today, yes — a frontier cloud model is stronger. The trade is ownership: this one is mine, runs offline, and remembers me without sending anything anywhere. That's the bet."
- *"How does this scale past one laptop?"* → "It doesn't yet, and on purpose — single-device is the whole privacy premise. The honest scaling question is sync across *your own* devices, not multi-tenant cloud. That's the next system-design problem, not a solved one." (Don't overclaim scale you haven't built — `me.md` is clear you haven't shipped horizontal-scale infra, so don't pretend.)

## The AI-honesty posture, in one frame

Because probe 4 is the one presenters fumble, here's the strong-vs-weak side by side. Memorize the right column's register.

```
  WEAK (defensive)                    STRONG (candid)
  ──────────────────────────────      ──────────────────────────────────
  "No no, I wrote most of it          "I used AI tools throughout, like at
   myself, the AI just helped a        work. The architecture and the
   little with syntax…"                schema decisions are mine; the tools
                                       accelerated the typing."
  → sounds like you're hiding         → sounds like a working engineer
    something                            in 2026
```

## The "tighten it" treatment

The Q&A doesn't run against a clock, so there's nothing to tighten for time. The discipline instead: **answer the question asked, then stop.** A judge asks "what's the stack" — name it and stop; don't volunteer the whole architecture. The follow-up trees exist so the depth comes out *when they pull for it*, not when you push it. Over-answering in Q&A is how a strong demo gets talked back down.

## The one-page run sheet — CHAPTER 06

```
  ┌─ THE Q&A ─ after the clock ─ answer asked, then STOP ───────┐
  │                                                              │
  │  "working?"   → ask their question live + run npm run eval,  │
  │                 read the REAL number. NEVER fabricate it.    │
  │  "hard part?" → emulated tool-calling; recovery I built;     │
  │                 next commit = arg-schema validation.         │
  │  "stack?"     → gemma2:9b/Ollama, nomic-embed 768, pgvector  │
  │                 HNSW, aptkit (my toolkit), Ink UI.           │
  │  "built it?"  → yes; aptkit pre-existed (my library); buffr  │
  │                 = persistence+CLI+memory. AI tools used,     │
  │                 openly. Decisions mine, typing accelerated.  │
  │  "business?"  → privacy wedge, framed as DIRECTION not       │
  │                 product. Single-device is the premise.       │
  │                                                              │
  │  POSTURE: ground it, own the rough edge, point to the depth. │
  │  Candor on AI use beats defensiveness. Answer, then stop.    │
  └──────────────────────────────────────────────────────────────┘
```

That's the book. Rehearse front-to-back twice, hold the run sheets on demo day, and land the money shot by 3:00.
