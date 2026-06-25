# Interview Defense — buffr-laptop

This is the book you read before you defend `buffr-laptop` in an interview. Not the comprehension guides (those live in `.aipe/study-*/` and teach you the patterns one at a time, slowly, with no pressure). This is the performance layer. It teaches you to take what you understand and say it out loud, in ninety seconds, while someone who has interviewed two hundred engineers is looking for the seam in your answer.

You built a real thing. A single-device laptop RAG agent: you index your own markdown corpus into Postgres + pgvector, then hold a live conversation with it through an Ink (React-in-terminal) chat CLI — it retrieves chunks and grounds an answer from a local Gemma model, remembers past exchanges across sessions, all on your machine, no cloud. The hard part of the interview is not whether the thing works. It's whether you understand what you shipped well enough to *own every choice in it* — including the ones an AI tool made for you. That last part is the 2026 reality, and this book trains you to meet it head-on rather than flinch.

```
  buffr-laptop — the whole system at a glance

  ┌─ CLI layer (entrypoints) ─────────────────────────────────┐
  │  npm run index      npm run chat       npm run eval        │
  │  src/cli/index-cmd  src/cli/chat.tsx   src/cli/eval-cmd    │
  │                     (Ink REPL, one     (precision@k)       │
  │                      live conversation)                   │
  └────────┬──────────────────┬─────────────────────┬─────────┘
           │ index path       │ query path          │ measure
           ▼                  ▼                     ▼
  ┌─ Library: @rlynjb/aptkit-core@^0.4.1 (consumed, never edited) ─┐
  │  RetrievalPipeline   RagQueryAgent (bounded ReAct loop)        │
  │  search_knowledge_base tool   GemmaModelProvider (emulates     │
  │  scorePrecisionAtK / scoreRecallAtK   tool-calling)           │
  │  createConversationMemory (@aptkit/memory — episodic recall)   │
  └────────┬──────────────────┬─────────────────────┬─────────────┘
           │ embed + upsert    │ search + generate    │
           ▼                   ▼                     │
  ┌─ Models (Ollama, localhost:11434) ──────────────▼────────────┐
  │  nomic-embed-text:v1.5  → vector(768)                         │
  │  gemma2:9b              → generation (NO native tool-calling) │
  └────────┬──────────────────────────────────────────────────────┘
           │ vectors + relational, ONE instance
           ▼
  ┌─ Storage: Postgres + pgvector (db reindb, schema agents) ─────┐
  │  documents   chunks(embedding vector(768), HNSW cosine)       │
  │    └─ memory rows ride chunks, tagged meta.kind='memory'      │
  │  conversations  messages(full 6-event trajectory)  profiles   │
  │  app_id on every table · NO RLS this phase                    │
  └───────────────────────────────────────────────────────────────┘
```

You'll return to this diagram. It's the master picture; every chapter zooms into one band of it.

  ┃ "The interview isn't testing whether the app works.
  ┃  It's testing whether you can own every line of it —
  ┃  including the lines an AI wrote."

## The book

Eight chapters, in order. Each one targets a phase of the interview.

| Ch | Title | The question it defends | Densest material for this repo |
|----|-------|--------------------------|-------------------------------|
| 01 | The pitch | "Tell me about a project you built." | Compression: 10s / 30s / 90s |
| 02 | The architecture | "Walk me through the system." | Index path + query path, the live chat session, whiteboarded |
| 03 | The choices | "Why this stack?" | pgvector, Gemma, local-first, the dropped FK, 768, Ink, memory |
| 04 | The scale story | "What breaks first at 10x?" | Synchronous index, HNSW untuned, no pooling limits |
| 05 | The failure story | "What happens when Ollama is down?" | No timeouts/retries, the hung-call freeze, best-effort memory |
| 06 | The hard parts | "Hardest bug? Proudest? Weakest?" | The dimension door, the faithfulness gap, the trace-sink fix |
| 07 | The counterfactuals | "What would you do differently?" | Faithfulness eval, atomic index, arg validation |
| 08 | The AI question | "Did you use AI to build this?" | The three modes of decision ownership |

## How to use it

**First read — in order, one chapter per sitting.** The chapters build. Chapter 2's architecture is the spine everything else hangs on; Chapter 8's AI honesty is woven through all seven before it. Read front to back at least once.

**Review — skim the visual treatments.** Every chapter has the same recurring motifs: the chapter-opening diagram, the "what they're really asking" boxes, the strong-vs-weak side-by-sides, the double-bordered "when you don't know" boxes, the follow-up decision trees, the pull quotes. Skim only those and you've got 70% of the book.

**Night before — read only the one-page summaries.** The last section of each chapter is built for the twelve-hours-out re-read: core claim, the questions with one-line answers, the pull quotes, the one thing you'd change. Eight pages total. That's your final pass.

## Where this fits with the rest of your prep

This book is the *wide opener* — it defends the whole project. When an interviewer drills into one decision (provider abstraction, the composite chunk id, HNSW internals), the *deep dive* lives in the per-concept "Interview defense" blocks inside `.aipe/study-system-design/` and `.aipe/study-ai-engineering/`. Those defend one decision in depth; this defends the project as a whole. Pair them. The concept files prepare you for "tell me more about that specific thing"; this book prepares you for "tell me about the thing."

  ┃ "Concept files for the deep dive. This book for
  ┃  the wide opener. You need both."

A note on honesty before you start. `buffr-laptop` consumes `@rlynjb/aptkit-core` as a library and never edits it. A lot of the cleverness — the agent loop, the tool-call emulation, the eval scorers, the conversation-memory engine — lives in that library, which an AI helped you assemble. The strong move is never to claim you wrote what you wired. It's to be exact about the seam: what you built (the Postgres persistence layer, the Ink chat CLI, the chat session, the pgvector adapter, the trace sink, the memory wiring), what you wired (the library), and what you'd change. That precision *is* the senior signal. The whole book trains it.

---

Updated: 2026-06-24 — reconciled the master diagram and chapter table to the current code: the sole interface is now `npm run chat` (Ink REPL, one live conversation) — `npm run ask` / `ask-cmd.ts` removed; library bumped to ^0.4.1; conversation memory added via `@aptkit/memory` (`createConversationMemory`, episodic recall riding the `chunks` table); trajectory capture upgraded to all six events.
