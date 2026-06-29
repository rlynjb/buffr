# Agent Patterns in This Codebase — buffr-laptop

The patterns buffr actually runs, not the study catalogue. One shape, named honestly, with
the control envelope and the eval seam called out. Read `00-overview.md` first for the
whole-system frame; this file is the close-out.

## The shape: single-agent bounded ReAct loop

buffr is one actor — a `RagQueryAgent` running a ReAct loop (`run-agent-loop`) over a local
Gemma2:9b, with exactly one read-only tool. The session layer (`src/session.ts`) wraps that
loop in a fixed three-step sequence per turn, so the *outer* shape is chain-like and the
*inner* shape is a true agent loop. Verdict: hybrid — pipeline outside, loop inside.

```
  buffr's one loop — single actor, one read-only tool

  ┌─ Session (pipeline, src/session.ts) ──────────────────────────┐
  │  ask(q):  persist user turn ─► agent.answer(q) ─► remember()   │
  │           (fixed order — engineer wrote these steps)          │
  └───────────────────────────┬───────────────────────────────────┘
                              │  agent.answer(q)  — the loop starts
  ┌─ ReAct loop (run-agent-loop.ts:76-202) ───────────────────────┐
  │   turn 0..5 (maxTurns:6):                                      │
  │     model.complete ──► model chooses:                         │
  │        ├─ tool_use: search_knowledge_base  (≤ maxToolCalls:4) │
  │        │     └─ harness runs it, feeds result back as obs     │
  │        └─ text only ──► SUCCESS exit (finalText)              │
  │     last turn OR budget spent ──► FORCED SYNTHESIS            │
  │        (tools stripped, "no more tool calls") ─► BUDGET exit  │
  └───────────────────────────────────────────────────────────────┘
```

## Patterns table

The patterns buffr exercises, the shape each instantiates, and why it's the right call.

```
  ┌──────────────────────────┬────────────────────────┬─────────────────────────────┐
  │ Feature                  │ Pattern / shape        │ Why this pattern            │
  ├──────────────────────────┼────────────────────────┼─────────────────────────────┤
  │ chat answer (ask/answer) │ single-agent ReAct loop │ path depends on what the    │
  │                          │ (run-agent-loop)       │ model finds; dynamic        │
  ├──────────────────────────┼────────────────────────┼─────────────────────────────┤
  │ knowledge retrieval      │ agentic RAG (ReAct      │ model decides whether/what  │
  │                          │ whose tool is search)  │ to search, 0..4 times       │
  ├──────────────────────────┼────────────────────────┼─────────────────────────────┤
  │ session turn flow        │ sequential pipeline of  │ known steps: persist →      │
  │ (session.ts)             │ functions (not agents) │ answer → remember           │
  ├──────────────────────────┼────────────────────────┼─────────────────────────────┤
  │ tool exposure            │ capability scoping      │ one read-only tool =        │
  │                          │ (ragQueryToolPolicy)   │ smallest blast radius       │
  ├──────────────────────────┼────────────────────────┼─────────────────────────────┤
  │ past-exchange recall     │ retrieval-based         │ relevance-recall across     │
  │ (@aptkit/memory)         │ episodic memory        │ sessions; same search tool  │
  ├──────────────────────────┼────────────────────────┼─────────────────────────────┤
  │ profile in prompt        │ context engineering     │ standing user context every │
  │ (injectProfile)          │ (profile-as-context)   │ turn                        │
  ├──────────────────────────┼────────────────────────┼─────────────────────────────┤
  │ Gemma tool calls         │ emulated tool calling   │ Gemma2 has no native tools  │
  │ (gemma-provider)         │ (the JSON path)        │ array; render as JSON       │
  ├──────────────────────────┼────────────────────────┼─────────────────────────────┤
  │ trajectory persistence   │ full-signal trace       │ replayable trajectory in    │
  │ (supabase-trace-sink)    │ capture                │ agents.messages             │
  └──────────────────────────┴────────────────────────┴─────────────────────────────┘
```

## The control envelope buffr ships with

```
  Control points around the loop — what bounds it

  ┌─ Input ───────────────────────────────────────────────────────┐
  │  user question (no input guardrail — read-only downstream)     │
  └───────────────────────────┬───────────────────────────────────┘
  ┌─ Agent loop ──────────────▼───────────────────────────────────┐
  │  • iteration cap     maxTurns:6      (rag-query-agent.ts:75)   │
  │  • tool-call budget  maxToolCalls:4  (rag-query-agent.ts:76)   │
  │  • forced synthesis  on budget/last  (run-agent-loop.ts:101-9) │
  │  • capability scope  ONE read tool   (ragQueryToolPolicy:15-18)│
  │  • context guard     maxTokens:8192  (session.ts:46)           │
  │  • result truncation 16k chars       (run-agent-loop.ts:52-57) │
  └───────────────────────────┬───────────────────────────────────┘
  ┌─ Output ──────────────────▼───────────────────────────────────┐
  │  finalText or FALLBACK_ANSWER — no side effects possible       │
  │  (the only tool is a read; nothing the agent emits can act)    │
  └───────────────────────────────────────────────────────────────┘
```

The load-bearing control is **forced synthesis** (`run-agent-loop.ts:101-109`): nothing
guarantees the model reaches the success exit on its own, so the budget exit strips the
tools and demands an answer. That is what makes this a shipped agent rather than a demo that
can loop forever.

## The eval seam

buffr **captures** the full trajectory — all six `CapabilityEvent` types into
`agents.messages` (`src/supabase-trace-sink.ts:49-94`), timestamped for deterministic
replay. It **evaluates** only precision@k over retrieval today (`src/cli/eval-cmd.ts`,
`eval/queries.json`). Trajectory eval — did it call the right tool, in the right order, did
it recover — is the gap: the signal is recorded, not yet scored.

## What buffr is not (and why that's the right call)

- **Not multi-agent.** One loop, one tool. The single-agent baseline hasn't hit a quality
  ceiling that decomposes into independent specialties — so the senior move is to stay
  single-agent. The two-brain laptop+phone split (`agent-layer-plan.md`) is the deferred,
  design-only topology buffr could grow into. See `03-multi-agent-orchestration/`.
- **Not plan-execute / reflexion / tree-of-thoughts.** Plain ReAct is the measured baseline.
  See `01-reasoning-patterns/`.
- **No in-prompt conversational threading.** `RagQueryAgent.answer` treats each question
  independently; relevance-recall via episodic memory stands in for it. See
  `04-agent-infrastructure/02-agent-memory-tiers.md`.
- **No MCP.** Tools are wired directly via `InMemoryToolRegistry`. See
  `04-agent-infrastructure/03-tool-calling-and-mcp.md`.
- **No fan-out / circuit-breaker state machine.** Single-device, single-user, local Ollama —
  no provider rate limit to manage. See `05-production-serving/`.

## See also

- `00-overview.md` — verdict + whole-system frame.
- `01-reasoning-patterns/02-agent-loop-skeleton.md` — the kernel buffr runs.
- `02-agentic-retrieval/01-agentic-rag.md` — the retrieval loop in depth.
- `04-agent-infrastructure/05-guardrails-and-control.md` — the control envelope in depth.
- `06-orchestration-system-design-templates/` — buffr reframed as three interview answers.
