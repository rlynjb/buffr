# Chapter 6 — The Q&A   (post-clock — prep only, never eats the slot)

## Opening hook

This chapter runs *after* the timed slot. It never counts against your ten
minutes. But it's where the judges decide whether the wow was real, so prep
it as carefully as the demo. The rule for every answer: crisp, honest,
speakable, anchored to what the code actually does. Where AI tools shaped
the build, own it matter-of-factly — judges in 2026 assume heavy AI use, and
defensiveness reads worse than candor.

You don't get a time-budget bar here — there's no clock. What you get is a
decision tree for each probe judges always ask, so you're never caught flat.

## The probes judges always ask — and your answers

### "Is this actually working, or is it a demo script?"

```
  ┃ "It's working. Everything you saw ran live against my own
  ┃  Postgres — npm run migrate built the schema, npm run index
  ┃  embedded my corpus, npm run chat is the running UI. The recall
  ┃  you saw was a real paraphrased query retrieving a stored
  ┃  exchange as the top hit — I can run it again right now."
```

Follow-up tree:

```
  "run it again" ──► do it. Use your KNOWN-GOOD paraphrase. If the
                     model skips search, say "stock Gemma's tool-calling
                     is emulated — let me ask more directly" and re-roll
                     ONCE. Honesty about the emulation is a strength here.

  "show me the    ──► npm run eval — precision@k over the labeled query
   numbers"            set. Show the REAL number on screen. Never quote a
                       number you didn't just run. If it's modest, say so:
                       "small labeled set, but it's a real measurement."
```

### "What was the hard part?"

```
  ┃ "Making an on-device model behave like an agent. Stock gemma2:9b
  ┃  has no native tool-calling, so I emulated the tool interface to
  ┃  get it to call the search tool at all — and designed the memory
  ┃  to ride that same tool so recall works through it."
```

The honest edge, volunteered: "It's not bulletproof — sometimes the model
answers without searching. I build around it with a reliable indexed corpus
and the retrieval-as-memory design."

### "What's the stack?"

```
  ┃ "TypeScript, all local. Gemma 2 9B and nomic-embed-text served by
  ┃  Ollama on my laptop. Postgres with pgvector for the store —
  ┃  768-dimension embeddings, HNSW cosine index. The terminal UI is
  ┃  Ink, React-in-terminal. The agent loop, retrieval pipeline, and
  ┃  memory engine come from my own aptkit toolkit, consumed as a
  ┃  published library; buffr adds the Postgres persistence and the
  ┃  chat CLI."
```

Follow-up tree:

```
  "why Postgres    ──► "vector + relational in one instance — past
   + pgvector, not      exchanges live in the SAME chunks table as docs,
   a vector DB?"        tagged kind='memory'. That co-location is exactly
                        why recall reuses the document search tool."

  "why local /     ──► "privacy and ownership. My notes and conversations
   why Ollama?"         never leave my machine. It's the local-first
                        evolution of cloud RAG I've shipped before."

  "what's aptkit?" ──► "my own AI toolkit — the agent loop, retrieval,
                        tools, evals, and the memory engine. I extracted
                        the conversation-memory engine UP from buffr into
                        aptkit and re-consume it. buffr is the persistence
                        layer and the interface on top."
```

### "Did you build this during the hackathon?"

Own the AI assistance plainly. Be specific about what the tools did versus
what you decided.

```
  ┃ "Yes. I used AI heavily to write code — that's normal now. The
  ┃  decisions are mine: the same-store memory design, the 768-dim
  ┃  pgvector schema, the library boundary with aptkit, emulating
  ┃  tool-calling for the local model. The architecture is the part
  ┃  that's me; the typing is faster with AI."
```

### "Is there a business here / what's next?"

```
  ┃ "Next is running conversational context on top of the
  ┃  retrieval-based memory — right now each question is answered
  ┃  independently, so recall is relevance-based, not threaded.
  ┃  After that, multi-device sync. The wedge is privacy: a personal
  ┃  AI that genuinely never leaves your machine — that's a real
  ┃  want, and almost nothing on the market does it."
```

Be honest that this is a project, not a company yet. "It's a working
prototype I'd want to keep building" is a fine, credible answer.

### "How is the memory different from just chat history?"

This is the question a sharp technical judge asks, and your best answer.

```
  ┃ "Chat history is sequential — the last N turns in the prompt.
  ┃  buffr's recall is retrieval-based: every exchange is embedded
  ┃  into the vector store, so a paraphrase from a DIFFERENT session
  ┃  surfaces the relevant past exchange by meaning, even if it was
  ┃  weeks ago and worded differently. It's episodic memory by
  ┃  similarity, not a transcript scroll."
```

## The decision tree for the curveball

When a question goes somewhere you didn't prep, don't bluff.

```
  An unexpected question →

  ┌─ Do I actually know this about my code? ─┐
  │                                           │
  YES                                        NO
  │                                           │
  ▼                                           ▼
  answer crisp, anchor to a file/command      "I don't know that
  ("that's in src/session.ts —                offhand — here's how
   the per-turn ask() persists then           I'd find out: …" name
   remembers the exchange")                   the file you'd open.
                                              NEVER fabricate a
                                              number or behavior.
```

The one hard rule, straight from the spec: show your real eval number,
never fabricate. If you don't have a number, say "I haven't measured that
yet" — that's a stronger answer than an invented metric, and a technical
judge will catch the invention.

## Cross-links — where the deep answers live

When a judge wants more depth than the demo's one level, these are your
sources. They're already generated in this repo.

```
  Deeper than this demo can go — point judges (and yourself) here:

  the memory / session mechanism
    → .aipe/study-system-design/05-long-lived-chat-session.md
    → .aipe/study-system-design/06-profile-injection-as-context.md

  the retrieval / RAG pipeline + vector store
    → .aipe/study-system-design/01-vector-store-adapter.md
    → .aipe/study-system-design/02-retrieval-pipeline.md
    → .aipe/study-ai-engineering/03-retrieval-and-rag/

  the agent loop + emulated tool-calling
    → .aipe/study-ai-engineering/04-agents-and-tool-use/

  evals / precision@k
    → .aipe/study-ai-engineering/05-evals-and-observability/

  the library boundary (aptkit as dependency)
    → .aipe/study-system-design/04-library-as-dependency-boundary.md

  the "why this way" defense (the sibling rehearsal book)
    → .aipe/rehearse-interview-defense/   (not yet generated — run
       /aipe:rehearse-interview-defense to produce it)
```

## The one-page run sheet — Chapter 6 (Q&A, post-clock)

```
  ┌─ THE Q&A ──────────────── after the clock, prep only ────────┐
  │                                                               │
  │  "Is it real?"   → "ran live against my Postgres; I can run   │
  │                     recall again right now." → do it.         │
  │  "Hard part?"    → "on-device model, no native tools — I      │
  │                     emulated them, memory rides the tool."    │
  │  "Stack?"        → TS · Gemma+nomic via Ollama · pgvector 768 │
  │                     HNSW · Ink · aptkit as a library.         │
  │  "Built it now?" → "yes, AI for code, decisions are mine."    │
  │  "What's next?"  → "threaded context on top of recall; then   │
  │                     multi-device. wedge is privacy."          │
  │  "vs chat hist?" → "retrieval-based episodic, across sessions,│
  │                     by meaning — not a transcript scroll."    │
  │                                                               │
  │  CURVEBALL: know it → anchor to a file. don't → "here's how   │
  │   I'd find out." NEVER fabricate a number. Show real eval.    │
  │                                                               │
  │  DEEP DIVES: study-system-design/05 (memory/session),         │
  │   study-ai-engineering/04 (agents+tools), /05 (evals).        │
  └───────────────────────────────────────────────────────────────┘
```

That's the book. Read it once with a timer, twice with the run sheets, and
the morning-of rehearse the money-shot line and the last line until
they're verbatim. Pre-flight the corpus and the stored exchange. Then go
land it.
