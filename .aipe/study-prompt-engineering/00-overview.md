# Overview — the prompt is assembled, not written

> One-page orientation. Read before any concept file.

Here's the thing that trips up everyone who opens this repo looking for "the prompt." There isn't one. You will `grep -r "You are"` across `src/` and find nothing. That's not a bug in your search — the prompt buffr sends to the model is **assembled at runtime, every turn, by three different owners**, and the constant text of it lives in `node_modules`, not in this repo's source.

I've shipped enough LLM features to tell you this is the normal shape, not an exotic one. The prompt-to-production pipeline almost never lives in one string literal. It lives in a chain of owners, each appending its piece. The skill this guide teaches is *seeing the assembly* — because once you can see it, you can reason about token budget, injection surface, and what breaks on a model upgrade. Until you can see it, you're debugging a string you can't find.

## The whole path in one diagram

The system prompt that reaches Gemma is built by stacking three contributions in a fixed order. The diagram below is the one to paraphrase six weeks from now.

```
  buffr-laptop — how one system prompt gets assembled, per turn

  ┌─ App layer (buffr) ───────────────────────────────────────────┐
  │  src/session.ts:47   loadProfile(pool, appId)  → me.md text    │
  │  src/session.ts:57   new RagQueryAgent({ profile, ... })       │
  └───────────────────────────┬───────────────────────────────────┘
                              │  hop 1: profile string passed in
                              ▼
  ┌─ Toolkit layer (aptkit RagQueryAgent) ────────────────────────┐
  │  injectProfile(BASE_SYSTEM, profile, {position:'start'})       │
  │                                                                │
  │     # About the person you are assisting   ← profile heading   │
  │     <me.md contents>                        ← personalization  │
  │                                                                │
  │     You are a personal knowledge assistant. ← BASE_SYSTEM      │
  │     Always call search_knowledge_base first…  grounding+cite   │
  └───────────────────────────┬───────────────────────────────────┘
                              │  hop 2: system string + toolSchemas
                              ▼
  ┌─ Provider layer (GemmaModelProvider) ─────────────────────────┐
  │  buildSystemText(): system  +  rendered tool catalog (text)   │
  │                                                                │
  │     <everything above>                                         │
  │     You can call the following tools:        ← tool-calling    │
  │     { "name": "search_knowledge_base", … }     prompt (JSON    │
  │     When a tool is needed, respond with ONLY    catalog as     │
  │     a single JSON object…                       text)         │
  └───────────────────────────┬───────────────────────────────────┘
                              │  hop 3: POST /api/chat  (Ollama)
                              ▼
                        ┌─ Gemma 2 9B ─┐
                        │  no native    │
                        │  tool API     │
                        └───────────────┘
```

Read it top to bottom and you've got the spine of this entire guide. Three layers, three contributions, one string.

## The three owners, named

Each owner adds exactly one thing and nothing else. That separation is what makes the prompt reasoned-about instead of a mystery blob.

- **buffr (the app)** owns the *personalization input*. It reads the profile out of Postgres (`loadProfile`, `src/profile.ts:4`) and hands it to the toolkit (`src/session.ts:57`). It does not write a single word of instruction text. Its whole prompt-engineering contribution is "here is who the user is."

- **aptkit `RagQueryAgent` (the toolkit)** owns the *system prompt* (`BASE_SYSTEM`) and the *context injection* (`injectProfile`). The system prompt is the grounding-and-citation instruction — "search first, ground every answer, cite sources, say so plainly if you don't know." The injection prepends the profile in front of it under a heading.

- **`GemmaModelProvider` (the provider)** owns the *tool-calling prompt* (the emulated JSON catalog). Gemma 2 9B has no native tool API, so the provider renders the tool definitions into the system text as JSON and asks the model to reply with a JSON object when it wants a tool. This is the single most load-bearing prompt-engineering decision in the repo.

## The one axis that makes the structure pop

If you trace one question — **"who decides the next move?"** — down the layers, the boundaries light up:

```
  axis: "who decides control flow?"

  ┌─ session.ts (fixed order)      → CODE decides   ┐ profile in, agent out
  ├─ RagQueryAgent.answer (loop)   → the LOOP drives ┤ search → synthesize
  ├─ Gemma (per turn)              → the MODEL picks ┤ "tool or prose?"
  └─ search_knowledge_base (tool)  → the TOOL runs   ┘ returns citations
```

Control flips from code, to a bounded loop, to the model's free choice, to a deterministic tool. Every flip is a seam where a prompt-engineering contract lives. The tool-call-emulation seam (model picks "JSON tool call or prose?") is the one that carries the most weight and breaks in the most interesting ways — that's [02-structured-outputs.md](02-structured-outputs.md).

## What grounding actually rides on

One non-obvious thing worth stating up front, because it reframes "grounding & citation": the system prompt *asks* for citations, but nothing enforces them. Grounding works in practice because the search tool hands the model **pre-formatted citation strings** (`[docId] snippet…`, `search-knowledge-base-tool.js:61`) that the model copies into its answer. The instruction is the ask; the tool output is the mechanism. Recalled conversation memory enters the same way — past exchanges are embedded into the same vector store and surface through the same `search_knowledge_base` tool, so they arrive as retrieved context, not as a separate memory channel. Details in [02-structured-outputs.md](02-structured-outputs.md) and [05-eval-driven-iteration.md](05-eval-driven-iteration.md).

Now go read [audit.md](audit.md) for the full lens-by-lens walk, or jump to [01-anatomy.md](01-anatomy.md) to start building the model.
