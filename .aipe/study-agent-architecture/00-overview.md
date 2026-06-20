# Agent Architecture — buffr

> One-page orientation. Read this first, then `audit.md`, then the pattern files.

## The verdict in one line

buffr is a **single-agent, bounded ReAct loop** with exactly one read-only
tool (`search_knowledge_base`) over stock Gemma 2:9b. It is not multi-agent,
not a chain, and not a planner. The whole agent lives in
`@rlynjb/aptkit-core`'s `runAgentLoop`; buffr supplies the model, the tool, a
standing profile, and a trajectory sink, then calls `agent.answer(question)`.

## The whole system in one frame

The agent loop is the inner box. buffr owns everything around it — the wiring,
the persistence, the corpus. aptkit owns the loop itself.

```
  buffr agent architecture — one shape, end to end

  ┌─ CLI layer (buffr) ──────────────────────────────────────────┐
  │  src/cli/ask-cmd.ts                                           │
  │   reads question argv → wires model, tool, profile, trace     │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ agent.answer(question)
  ┌─ Agent layer (aptkit) ────────▼──────────────────────────────┐
  │  RagQueryAgent  →  runAgentLoop                              │
  │    ┌──────────────────────────────────────────────┐          │
  │    │  reason (Gemma) → act (1 tool) → observe → … │ ≤6 turns │
  │    │  forced final-synthesis turn at the budget    │ ≤4 calls │
  │    └──────────────────────────────────────────────┘          │
  └───────┬───────────────────────────┬──────────────────────────┘
          │ search_knowledge_base      │ trace.emit(step|tool_call)
  ┌─ Retrieval (aptkit+buffr) ─▼──┐ ┌─▼ Trajectory (buffr) ───────┐
  │ pipeline → PgVectorStore      │ │ SupabaseTraceSink →         │
  │ → pgvector HNSW (768-dim)     │ │ agents.conversations/.messages
  └───────────────────────────────┘ └─────────────────────────────┘
          │                                       │
  ┌─ Provider / Storage ─────────────────────────▼───────────────┐
  │  Ollama: gemma2:9b + nomic-embed-text  ·  Postgres reindb     │
  └──────────────────────────────────────────────────────────────┘
```

## Which of the three shapes

The spec frames every codebase as one of three shapes. buffr is unambiguously
the middle one:

| Shape          | buffr?  | Why                                                      |
| -------------- | ------- | -------------------------------------------------------- |
| Workflow/chain | no      | The model chooses whether and what to search; not fixed. |
| **Single-agent** | **yes** | One ReAct loop, one tool, one actor, model picks the path.|
| Multi-agent    | no      | No second agent, no supervisor, no handoff. Design-only. |

Coverage is weighted toward single-agent reasoning patterns and agentic
retrieval. Multi-agent orchestration is taught as "what you'd reach for" and
honestly marked **not yet exercised**.

## What's load-bearing here

Three mechanics carry this architecture. In order of how surprising they are:

1. **The forced synthesis turn.** At the last turn (or when the tool budget is
   spent) `runAgentLoop` strips the tool schemas and appends a "you have NO
   more tool calls" instruction. This is what guarantees the loop produces an
   answer instead of looping on `search` forever. Most important mechanic in
   the codebase — see `01-bounded-react-loop.md`.
2. **The single-tool allowlist.** `ragQueryToolPolicy.allowedTools` is exactly
   `['search_knowledge_base']`. The blast radius of this agent is one
   read-only retrieval call. See `02-single-tool-capability-scope.md`.
3. **Tool calling is emulated, not native.** Gemma 2 has no tool API. The
   Gemma provider renders tool schemas into the system prompt and parses a
   JSON blob back out. See `05-emulated-tool-calling.md`.

## Reading order

```
  00-overview.md   (you are here)
       │
  audit.md         Pass 1 — every lens, file:line or "not yet exercised"
       │
  01 → 06          Pass 2 — the patterns this repo actually exercises
```

The pattern files are self-contained; read them in any order, but `01` (the
bounded ReAct loop) is the spine the rest hang off.
