# Agent patterns in buffr-laptop

The patterns this repo actually uses — the structure, not the full
implementation. buffr is a **single-agent** system: one bounded ReAct
loop over one read-only tool. Below is the table, then each pattern's
shape, control envelope, and eval.

## Agent patterns table

```
  ┌──────────────────────────┬─────────────────────┬─────────────────────────────┐
  │ Feature                  │ Pattern / shape     │ Why this pattern            │
  ├──────────────────────────┼─────────────────────┼─────────────────────────────┤
  │ chat answer (the agent)  │ single-tool ReAct   │ action space is one read-   │
  │                          │ (single-agent)      │ only retrieval; model       │
  │                          │                     │ decides search-or-answer    │
  ├──────────────────────────┼─────────────────────┼─────────────────────────────┤
  │ retrieval                │ agentic RAG         │ retrieval IS the loop's one │
  │                          │ (single-agent)      │ tool; can refine + re-query │
  ├──────────────────────────┼─────────────────────┼─────────────────────────────┤
  │ session.ask              │ chain (workflow)    │ persist→answer→remember is  │
  │                          │                     │ a fixed engineer-written    │
  │                          │                     │ order                       │
  ├──────────────────────────┼─────────────────────┼─────────────────────────────┤
  │ memory                   │ retrieval-based     │ recall by relevance via the │
  │                          │ episodic memory     │ same search tool; NO in-    │
  │                          │                     │ prompt history threading    │
  ├──────────────────────────┼─────────────────────┼─────────────────────────────┤
  │ tool calling             │ emulated tool-call  │ Gemma has no native tools;  │
  │                          │                     │ schema in prompt, JSON out  │
  ├──────────────────────────┼─────────────────────┼─────────────────────────────┤
  │ system prompt            │ profile-as-standing-│ me.md-style profile injected│
  │                          │ context             │ every turn for grounding    │
  └──────────────────────────┴─────────────────────┴─────────────────────────────┘
```

## The one agent — single-tool ReAct (the load-bearing pattern)

**Shape: single-agent.** One `RagQueryAgent.answer` per turn, delegating
to `runAgentLoop` (`rag-query-agent.js:35` → `run-agent-loop.js:20`).

```
  the loop (capped 6 turns / 4 tool calls)

  question → ┌─ ReAct loop ──────────────────────────────┐
             │ Thought → search_knowledge_base → Observe  │
             │    ▲                                  │     │
             │    └──────── loop, capped ────────────┘     │
             │ forced synthesis on last turn → answer      │
             └────────────────────────────────────────────┘
```

**Control envelope:** `maxTurns: 6`, `maxToolCalls: 4`, forced synthesis
(tools stripped + "no more tool calls") on the budget exit
(`run-agent-loop.js:25-34`); `ContextWindowGuardedProvider` halts at
8192 tokens (`src/session.ts:46`); one read-only tool → no side effects
(`ragQueryToolPolicy`, `rag-query-agent.js:8-11`).

**Eval:** retrieval scored with precision@k over a labeled set
(`eval/queries.json`, `src/cli/eval-cmd.ts`); the full trajectory
captured into `agents.messages` (`src/supabase-trace-sink.ts`) but not
yet scored for tool-call accuracy / recovery.

## Agentic RAG — the loop's one tool

**Shape: single-agent (retrieval specialization).** The single action is
`search_knowledge_base` (`src/session.ts:42-44`), so the ReAct loop *is*
agentic RAG. Up to 4 retrievals per question, model-decided; in practice
usually one.

```
  search(q) → chunks → model: enough? → search(q') | answer   (cap 4)
```

**Control envelope:** `minTopK: 4` floor against under-fetching
(`search-knowledge-base-tool.js:32`); the same loop caps.

## The session chain — the workflow wrapping the agent

**Shape: workflow / chain.** `session.ask` runs three fixed steps:
persist user turn → `agent.answer` → flush trace + remember
(`src/session.ts:60-70`). Engineer-written order; only the middle step
is an agent.

```
  persistMessage(user) → agent.answer(q) → trace.flush() + memory.remember(q,a)
```

## Memory — retrieval-based episodic, the honest distinction

**Shape: single-agent infrastructure.** After each turn,
`memory.remember` embeds the exchange tagged `kind=memory` into the same
`chunks` store (`src/session.ts:67`, `conversation-memory.js`). Future
turns recall relevant past exchanges through the *same*
`search_knowledge_base` tool.

```
  remember(q,a) → embed → chunks[kind=memory]
  next Q → search_knowledge_base → recalls relevant past exchanges
           ✓ relevance recall (cross-session)
           ✗ NO in-prompt conversation threading (messages = [just this Q])
```

**The honest boundary:** relevance recall yes; conversational-context
threading no — `RagQueryAgent.answer` treats each question independently
(`run-agent-loop.js:22`; comment at `src/session.ts:25-27`).

## Emulated tool calling

**Shape: single-agent infrastructure.** Gemma has no native tools, so
`GemmaModelProvider` renders the tool schema into the system prompt and
parses a JSON tool call back out, retrying once with a nudge if malformed
(`gemma-provider.js:82-125`). The loop is unaware it was emulated.

## Profile as standing context

**Shape: single-agent infrastructure.** A `me.md`-style profile from
`agents.profiles` is injected at the start of the system prompt every
turn (`injectProfile`, `rag-query-agent.js:28-32`; `src/profile.ts`).
Standing context for grounding, not retrieved per query.

## What buffr does NOT use (and why that's correct)

- **Multi-agent orchestration** — one actor; the task isn't decomposable
  into independent specialties (`03-.../01-when-not-to-go-multi-agent.md`).
- **plan-and-execute / reflexion / tree-of-thoughts** — ReAct hasn't hit
  a measured ceiling that justifies escalation.
- **In-prompt conversational memory** — deliberate; retrieval-based
  recall compensates, threading is an aptkit-side change.
- **MCP** — one in-process tool; no cross-agent tool sharing needed.
- **Trajectory eval / cross-turn caching / circuit breaking** — captured
  or bounded by caps, but not yet scored / cached / short-circuited;
  acceptable at single-user local scale.

The honest read: buffr is at the ceiling of *correct single-agent
design* and has not hit a quality wall that a more complex topology would
clear. Its next moves are within-single-agent upgrades (a relevance
grader, in-prompt history, trajectory scoring) — not multi-agent.

## See also

- `00-overview.md` — the full agent surface map
- `01-reasoning-patterns/02-agent-loop-skeleton.md` — the kernel
- `04-agent-infrastructure/02-agent-memory-tiers.md` — the memory
  distinction in full
- `06-orchestration-system-design-templates/` — buffr as interview
  templates
