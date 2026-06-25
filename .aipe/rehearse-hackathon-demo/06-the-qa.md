# Chapter 06 — The Q&A   (after the clock — prep only)

## Opening hook

This chapter never touches the ten minutes. It runs *after* the timed slot, when the judges lean in and start probing. But you prep it like part of the demo, because the questions are predictable — judges ask the same five things at every hackathon, and the demo that has crisp, honest, speakable answers wins the room a second time. The trap here is getting defensive about the rough edges. Don't. In 2026 judges assume heavy AI-tool use and rough hackathon builds — candor reads better than polish-theater every single time. Own what's real, name what's next, never bluff a number you don't have.

The discipline for every answer below: short, true, anchored to the actual codebase, then stop. If you don't know, say "I don't know — here's how I'd find out." That answer beats a confident wrong one in front of anyone technical.

## The chapter-opening diagram — the five probes and where each goes

Here are the five questions judges always ask, and the one-line spine of each answer. The rest of the chapter expands them.

```
  THE FIVE PROBES — and the spine of each answer

  ┌─ "Is this actually working?" ──────────────────────────────┐
  │  → yes, you saw it live; the recall was real, not staged    │
  └─────────────────────────────────────────────────────────────┘
  ┌─ "What was the hard part?" ────────────────────────────────┐
  │  → Gemma has no native tools; I emulate + retry once        │
  └─────────────────────────────────────────────────────────────┘
  ┌─ "What's the stack?" ──────────────────────────────────────┐
  │  → TS/Node, Ollama (gemma2:9b + nomic), Postgres+pgvector,  │
  │    my own aptkit toolkit, all local                         │
  └─────────────────────────────────────────────────────────────┘
  ┌─ "Did you build this in the hackathon?" ───────────────────┐
  │  → yes; RAG/on-device instincts from prior shipped projects │
  └─────────────────────────────────────────────────────────────┘
  ┌─ "Is there a business / what's next?" ─────────────────────┐
  │  → privacy-first personal AI; next is turn-history + sync   │
  └─────────────────────────────────────────────────────────────┘
```

## The body — each probe, with a speakable answer

### "Is this actually working, or is it staged?"

```
┃ "It's working — you saw the recall live. The money shot is a
┃  paraphrased question pulling back a real exchange from a prior
┃  session, retrieved by similarity from my Postgres. The one thing
┃  I can't fully guarantee live is whether Gemma calls the search
┃  tool every time — that's the emulation, and it's why I had a
┃  backup ready."
```

Anchor: `src/session.ts` `memory.remember()` writes the exchange; recall comes back through the same `search_knowledge_base` tool. Honest edge: emulated tool-calling means occasional misses — own it, don't hide it.

### "What was the hard part?"

```
┃ "Stock gemma2:9b has no native tool-calling — no tools parameter,
┃  no structured tool_use response. So I emulate it: render the tool
┃  schema into the system prompt, parse a JSON object back out of
┃  free text, and retry once with a nudge if it drifts. It's the
┃  single most fragile seam in the system, and I know exactly where
┃  it lives."
```

Anchor: the `GemmaModelProvider` does outbound prompt-rendering + inbound `parseToolCall`, max two attempts. Deep version in `.aipe/study-ai-engineering/04-gemma-tool-call-emulation.md`.

### "What's the stack?"

```
┃ "TypeScript on Node, all local. Ollama serves two models — gemma2:9b
┃  for generation, nomic-embed-text for 768-dim embeddings. Postgres
┃  with pgvector and an HNSW cosine index stores the corpus AND the
┃  conversation memory. The AI layer is my own toolkit, aptkit, which
┃  buffr consumes as a library. The chat UI is Ink — React in the
┃  terminal."
```

Anchor: `package.json` (`@rlynjb/aptkit-core ^0.4.1`, `ink`, `pg`), project context for the model + schema details.

### "Did you build this during the hackathon? How much is AI-assisted?"

```
┃ "Yes, this build was the hackathon. The instincts behind it aren't
┃  new though — I've shipped classic RAG before in AdvntrCue (pgvector,
┃  GPT-4, tool-calling, session memory), and on-device AI in contrl
┃  and dryrun. buffr is the local-first, self-hosted version of a shape
┃  I've shipped in the cloud. And yes, I used AI tooling heavily to
┃  build it — that's how I work; I direct it and I own every line."
```

This is the candor move the spec calls for: matter-of-fact about AI assistance, no defensiveness. You directed the build; the tools accelerated it.

### "Is there a business here? What's next?"

```
┃ "The bet is privacy-first personal AI — an assistant that knows you
┃  and remembers you without your data leaving your machine. That's a
┃  real wedge as people get uneasy about feeding their lives to cloud
┃  models. What's next technically: sequential turn-history inside a
┃  session (today each question is handled independently — recall is
┃  relevance-based, not in-prompt history), a native-tool model to
┃  harden the emulation, and multi-device sync. Today it's single-device,
┃  no RLS — those are the honest gaps."
```

Anchor: the in-prompt-history gap is named in `src/session.ts`; single-device + no-RLS in the project context.

## The follow-up decision tree

When a judge keeps pulling on a thread, here's where each one goes. Don't improvise depth — route to the answer you already have.

```
  FOLLOW-UP ROUTING

  "but isn't recall just a chat-log scroll?"
     → NO. It's retrieval by meaning: a PARAPHRASED query pulls the
       past exchange by similarity. The messages table (the log) is
       for observability; the vector memory is what makes recall work.
       (Chapter 03 has the diagram.)

  "why Gemma and not a model with real tools?"
     → to run fully local and free. The fragility is the price. A
       native-tool model is a PROVIDER SWAP behind the same seam, not
       a rewrite — that's the payoff of the provider abstraction.

  "how do you know retrieval is any good?"
     → I have an offline eval — npm run eval scores precision@1 and
       recall@k against a labeled query set (eval/queries.json). It's
       small and honest; no LLM-judge yet. [Show your captured number
       if you have it — never invent one.]

  "what happens if two memories collide / how do you keep them apart?"
     → namespaced ids (memory:<conversationId>:<n>) + a meta.kind tag.
       Drop the tag and recall can't separate memory from documents;
       drop the namespaced id and the second exchange overwrites the
       first. (Chapter 03's shared-drawer diagram.)

  "could this leak my data?"
     → nothing leaves the laptop in the hot path — model on Ollama
       localhost, corpus + memory in local Postgres. Honest caveat:
       no RLS this phase, single-device — so it's not multi-user-safe
       yet. That's named, not hidden.
```

## The "I don't know" move

You will get a question you can't answer. The recovery is the same every time, and it's a strength, not a weakness:

```
┃ "I don't know that one. Here's how I'd find out: [the file or the
┃  test I'd open / the experiment I'd run]. I'd rather give you that
┃  than guess a number."
```

Never invent a metric. The eval numbers are real and small; if you didn't capture a specific figure, say "I ran the eval, it's a small labeled set — I'd want to show you the exact number rather than guess." That honesty is worth more than a fabricated precision score.

## The one-page run sheet — Q&A PREP

```
  ┌─ RUN SHEET · 06 Q&A · after the clock ─────────────────────────┐
  │                                                                 │
  │  FIVE PROBES → spine:                                           │
  │   • working? → yes, recall was live + real (emulation = caveat) │
  │   • hard part? → Gemma no native tools; emulate + retry once    │
  │   • stack? → TS/Node · Ollama (gemma2:9b + nomic) · pg+pgvector │
  │              · my aptkit toolkit · Ink — all local              │
  │   • built it? → yes; RAG from AdvntrCue, on-device from contrl/ │
  │                 dryrun; AI-assisted, I own every line           │
  │   • business/next? → privacy-first personal AI; next = turn-    │
  │                       history + native-tool model + sync        │
  │                                                                 │
  │  ROUTE follow-ups: recall≠chatlog · Gemma=local/free tradeoff · │
  │   eval=precision@1 (real number, never invent) · id+tag keep    │
  │   memories apart · no-RLS/single-device is named not hidden     │
  │                                                                 │
  │  DON'T KNOW: "here's how I'd find out" + the file. Never bluff  │
  │  a metric. Candor > polish — judges assume AI use + rough edges.│
  └─────────────────────────────────────────────────────────────────┘
```

## See also

- `00-overview.md` — the run-of-show and pre-flight checklist
- `.aipe/rehearse-interview-defense/` — the deep "how does it actually work" answers
- `.aipe/study-ai-engineering/08-conversation-memory.md` — the money shot's engine
- `.aipe/study-ai-engineering/04-gemma-tool-call-emulation.md` — the honest risk, in full
- `.aipe/study-ai-engineering/06-evals-precision-and-recall.md` — the eval numbers
