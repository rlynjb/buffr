# Agent Patterns in This Codebase — buffr-laptop

The patterns buffr actually runs, not the study catalogue. One shape, named honestly, with
the control envelope and the eval seam called out. Read `00-overview.md` first for the
whole-system frame; this file is the close-out.

## The shape: single-agent bounded ReAct loop over multiple tools

buffr is one actor — a `RagQueryAgent` running a ReAct loop (`run-agent-loop`) over a local
Gemma2:9b, with up to **six read-only tools** (KB search always present; web search, RSS,
Amazon conditional on API key / availability). The session layer (`src/session.ts`) wraps that
loop in a fixed sequence per turn. Verdict: hybrid — pipeline outside, loop inside.

```
  buffr's one loop — single actor, 6 read-only tools

  ┌─ Session (pipeline, src/session.ts) ──────────────────────────┐
  │  ask(q):  set trace slots ─► persist user turn                 │
  │           ─► agent.answer(q) ─► clear slots ─► remember()     │
  │           (fixed order — engineer wrote these steps)          │
  └───────────────────────────┬───────────────────────────────────┘
                              │  agent.answer(q)  — the loop starts
  ┌─ ReAct loop (run-agent-loop.ts:76-202) ───────────────────────┐
  │   turn 0..5 (maxTurns:6):                                      │
  │     model.complete ──► model chooses:                         │
  │        ├─ tool_use: search_knowledge_base  (always)           │
  │        ├─ tool_use: web_search_google/brave/tavily (if keyed) │
  │        ├─ tool_use: fetch_rss_feed (always)                   │
  │        ├─ tool_use: fetch_amazon_reviews (always)             │
  │        │     └─ harness runs it, fires onStatus callback      │
  │        │          feeds result back as observation             │
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
  │ + minScore filter        │ whose tool is search)  │ to search; threshold guards │
  │                          │                        │ against topic-drift answers │
  ├──────────────────────────┼────────────────────────┼─────────────────────────────┤
  │ web search               │ conditional capability  │ keys present → live web;   │
  │ (google/brave/tavily)    │ fan-out (DataConnector) │ priority: tavily > brave   │
  │                          │                        │ > google (first available)  │
  ├──────────────────────────┼────────────────────────┼─────────────────────────────┤
  │ RSS live feed            │ DataConnector<P,D>      │ current articles on demand  │
  │ (fetch_rss_feed)         │ connector adapter       │ — same tool-dispatch path   │
  ├──────────────────────────┼────────────────────────┼─────────────────────────────┤
  │ session turn flow        │ sequential pipeline of  │ known steps: set slots →    │
  │ (session.ts)             │ functions (not agents) │ persist → answer → remember │
  ├──────────────────────────┼────────────────────────┼─────────────────────────────┤
  │ tool exposure            │ capability scoping      │ read-only tools only =      │
  │                          │ (allowedTools list)    │ smallest blast radius       │
  ├──────────────────────────┼────────────────────────┼─────────────────────────────┤
  │ live TUI status          │ mutable-trace-slot      │ per-ask callback slots in   │
  │ (onStatus / onTokens)    │ pattern (session.ts:   │ trace.emit() — no agent     │
  │                          │ 120-138)               │ loop changes needed         │
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
  ├──────────────────────────┼────────────────────────┼─────────────────────────────┤
  │ corpus preparation       │ offline batch pipeline  │ not an agent pattern —      │
  │ (npm run index:db)       │ (DbSource config-obj   │ deterministic config-driven │
  │                          │ + sanitize + index)    │ ETL; runs once, not per-ask │
  └──────────────────────────┴────────────────────────┴─────────────────────────────┘
```

## The control envelope buffr ships with

```
  Control points around the loop — what bounds it

  ┌─ Input ───────────────────────────────────────────────────────┐
  │  user question (no input guardrail — read-only downstream)     │
  └───────────────────────────┬───────────────────────────────────┘
  ┌─ Agent loop ──────────────▼───────────────────────────────────┐
  │  • iteration cap     maxTurns:6        (rag-query-agent.ts:75) │
  │  • tool-call budget  maxToolCalls:4    (rag-query-agent.ts:76) │
  │  • forced synthesis  on budget/last    (run-agent-loop.ts:101) │
  │  • capability scope  6 read-only tools (session.ts:144-153)   │
  │  • context guard     maxTokens:8192    (session.ts:106)        │
  │  • result truncation 16k chars         (run-agent-loop.ts:52) │
  │  • KB quality gate   minScore:0.65     (session.ts:72)         │
  │  • routing rules     tool-use rules 1-7 in system prompt      │
  └───────────────────────────┬───────────────────────────────────┘
  ┌─ Output ──────────────────▼───────────────────────────────────┐
  │  finalText or FALLBACK_ANSWER — no side effects possible       │
  │  (all tools are reads; nothing the agent emits can write)      │
  └───────────────────────────────────────────────────────────────┘
```

The load-bearing control is still **forced synthesis** (`run-agent-loop.ts:101-109`). The addition of five more tools increases the schema injected into the system prompt — a real context-window cost, since Gemma's emulated tool calling encodes schemas as text. The `maxToolCalls:4` budget now covers multi-source synthesis in most turns (KB + web + RSS in three calls, leaving one for a follow-up).

## The eval seam

buffr **captures** the full trajectory — all six `CapabilityEvent` types into
`agents.messages` (`src/supabase-trace-sink.ts:49-94`), timestamped for deterministic
replay. It **evaluates** only precision@k over retrieval today (`src/cli/eval-cmd.ts`,
`eval/queries.json`). Trajectory eval — did it call the right tool, in the right order, did
it recover — is the gap: the signal is recorded, not yet scored.

## What buffr is not (and why that's the right call)

- **Not multi-agent.** One loop, multiple tools. The single-agent baseline hasn't hit a quality
  ceiling that decomposes into independent specialties — the right call is to stay
  single-agent with more tools rather than split. The two-brain laptop+phone split
  (`agent-layer-plan.md`) is the deferred design-only topology. See `03-multi-agent-orchestration/`.
- **Not plan-execute / reflexion / tree-of-thoughts.** Plain ReAct with routing rules is the
  measured baseline. See `01-reasoning-patterns/`.
- **No in-prompt conversational threading.** `RagQueryAgent.answer` treats each question
  independently; relevance-recall via episodic memory stands in for it. See
  `04-agent-infrastructure/02-agent-memory-tiers.md`.
- **No MCP.** Tools are wired directly via `InMemoryToolRegistry`. The six current tools are
  all buffr-owned wrappers. See `04-agent-infrastructure/03-tool-calling-and-mcp.md`.
- **No fan-out parallelism.** Tools are called sequentially (Gemma calls one at a time;
  the harness awaits each result before the next turn). See `05-production-serving/`.
- **No web-search retry / fallback.** If Tavily 429s, that tool call fails and Gemma may
  or may not try Brave next. No circuit-breaker, no automatic fallback across providers.

## See also

- `00-overview.md` — verdict + whole-system frame.
- `01-reasoning-patterns/02-agent-loop-skeleton.md` — the kernel buffr runs.
- `02-agentic-retrieval/01-agentic-rag.md` — the retrieval loop in depth.
- `04-agent-infrastructure/05-guardrails-and-control.md` — the control envelope in depth.
- `06-orchestration-system-design-templates/` — buffr reframed as three interview answers.
