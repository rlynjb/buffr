# Tool routing — heuristic vs LLM routing

*Industry standard (tool selection / dispatch). buffr has ONE tool, so there is no routing decision today — this is mostly study + Case B.*

## Zoom out, then zoom in

Routing is the question "given a request and several tools, which one fires?" buffr can't ask it yet — there's exactly one tool, `search_knowledge_base`. The model's only choice is binary: retrieve, or answer directly. So this file is honest up front: **the routing decision is degenerate in buffr today.** It's worth studying because adding a second tool turns it on, and the seam where it would live is already visible.

```
  Zoom out — where routing WOULD live (one tool today)

  ┌─ Agent loop (aptkit) ───────────────────────────────────────┐
  │  runAgentLoop — model picks: tool-call or final answer       │  ← we are here
  │   ★ with ONE tool, "routing" = retrieve-or-answer (binary) ★ │
  └───────────────────────────┬─────────────────────────────────┘
                              │  callTool(name, args)
  ┌─ Tool registry ───────────▼─────────────────────────────────┐
  │  InMemoryToolRegistry — ONE handler: search_knowledge_base   │
  │   (a second tool here would create a real routing choice)    │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: there are two ways to route. **Heuristic routing** — your code inspects the request and picks the tool (a regex, a keyword, a classifier you wrote). **LLM routing** — you hand the model the tool schemas and let *it* choose by emitting the matching tool-call. buffr is set up for LLM routing (the model would choose), but with one tool there's nothing to choose between. The skill to learn here is what makes LLM routing reliable, so it's ready the day you add tool number two.

## Structure pass

**Layers:** the request → the routing decision (who picks the tool) → the chosen tool's handler.

**Axis — "who decides which tool, and how reliable is that decision?"**

```
  trace "who picks the tool" across the two routing styles

  ┌─ heuristic ─────────────┐   CODE decides (deterministic, you wrote the rule)
  │  if /list/.test(q) → A   │   reliable, but you maintain the rules
  └─────────────────────────┘
  ┌─ LLM ───────────────────┐   MODEL decides (it emits the tool-call)
  │  model sees [A,B] schemas│   flexible, but only as reliable as the model
  │  → picks one             │   (on Gemma: emulated, unvalidated → see 02)
  └─────────────────────────┘
  ┌─ buffr today ───────────┐   MODEL decides, but only ONE option → no real choice
  └─────────────────────────┘
```

**The seam:** the routing decision sits at the loop→registry boundary — the model emits `{tool: name, ...}`, the registry dispatches by name (`tool-registry.ts:50-63`). With one registered handler, the name is always the same; the seam exists but carries no decision. Register a second handler and the same seam suddenly carries a real choice — and inherits the Gemma emulation's unvalidated-name risk (`02-tool-calling.md`).

## How it works

### Move 1 — the mental model

Heuristic routing is a `switch` statement you wrote: `switch(intent) { case 'list': listDocs(); case 'search': searchKb(); }`. LLM routing is handing the model the list of `case` labels and letting it pick the branch by name. buffr is the second kind — but with a one-case switch, so the model "picks" the only branch every time.

```
  routing — two ways to choose a tool

  HEURISTIC (code picks)            LLM (model picks)
  ──────────────────────            ─────────────────
  request                           request + [schema A, schema B]
    │ your rule (regex/classifier)    │ model.complete
    ▼                                 ▼  emits {tool: "B", args}
  pick tool A                       registry dispatches B
                                      │
  buffr: model picks, but registry = [search_knowledge_base] only
         → the choice collapses to retrieve-or-answer
```

### Move 2 — the step-by-step walkthrough

There's no live routing path to walk in buffr, so this walks **how LLM routing works and where buffr would slot a second tool.**

**Step 1 — tools are registered by name in a registry.** buffr builds an `InMemoryToolRegistry` with exactly one tool. The registry is a name→handler map; routing is "look up the name the model picked."

```ts
// src/session.ts:43-44
const tool = createSearchKnowledgeBaseTool(pipeline, { minTopK: 4 });
const tools = new InMemoryToolRegistry([tool.definition], { [tool.definition.name]: tool.handler });
//                                      ^ ONE definition          ^ ONE handler → no routing choice
```

A second tool would be a second `definition` in the array and a second entry in the handler map. That alone turns the model's choice from binary (retrieve-or-answer) into a real selection (which-tool-or-answer).

```
  Step 1 — the registry IS the routing table

  InMemoryToolRegistry([defA], { A: handlerA })          ← buffr today, 1 row
  InMemoryToolRegistry([defA, defB], { A:.., B:.. })     ← Case B, real routing table
```

**Step 2 — the model sees all registered schemas in its prompt and picks one.** On Gemma, every tool's schema is rendered into the system prompt (`gemma-provider.ts:137-162`, from `02-tool-calling.md`), and the model is told to reply with `{"tool": "<name>", "arguments": {...}}`. With two tools rendered, the *name* the model emits IS the routing decision.

```ts
// aptkit packages/runtime/src/run-agent-loop.ts:159 (dispatch by the chosen name)
const { result, durationMs } = await tools.callTool(toolUse.name, toolUse.input, { signal });
//                                                  ^ this name = the route the model chose
```

So LLM routing is "the model writes a name, the registry dispatches it." Reliable routing then depends on two things the model can get wrong: picking the right *name* (a routing error) and supplying the right *args* (a contract error — the `02-tool-calling.md` ceiling). With one tool, only the second can happen; with two, both can.

```
  Step 2 — the chosen name routes the call

  model emits {"tool":"list_documents", "arguments":{}}
                      │ toolUse.name = "list_documents"
                      ▼
  registry.callTool("list_documents", {})  ─► handlerB runs   (routed)
  (wrong name → callTool throws → recoverable, see 06-error-recovery)
```

**Step 3 — heuristic routing is the deterministic alternative (buffr doesn't use it).** If LLM routing proves unreliable on Gemma, the fallback is to route in code before the loop — inspect the question, pick the tool, skip the model's choice. buffr has no such code; it would live as a buffr-side pre-step. The tradeoff: deterministic and testable, but you own every rule and lose the model's flexibility on ambiguous requests.

```
  Step 3 — heuristic route (the alternative buffr could add)

  question ─► if /^(list|show all)/ → call list_documents directly
           ─► else                  → run the agent loop (LLM routes)
  (deterministic; you maintain the rules; no model call to choose)
```

### Move 2.5 — current state vs future state

```
  Phase A (today)                      Phase B (add a 2nd tool)
  ─────────────                        ───────────────────────
  registry = 1 tool                    registry = 2+ tools
  model choice = retrieve OR answer    model choice = which tool OR answer
  no routing error possible            routing error possible (wrong name)
  routing untestable (nothing to route)routing testable (right tool per query)
```

The migration is small and entirely buffr-side: add a `list_documents` (or `summarize`) tool definition + handler, register it at `src/session.ts:44`. What doesn't change: the loop, the provider, the dispatch — `callTool` already routes by name. You're just giving it more than one name to route to. The new risk you inherit: a wrong-name route (recoverable, `06-error-recovery.md`) and the existing unvalidated-args ceiling now applies per-tool (`02-tool-calling.md`).

### Move 3 — the principle

Routing reliability is the cost of tool count. One tool: zero routing risk, zero routing tests needed. Two tools: the model can pick wrong, and you now need an eval that proves it picks right per query type. The decision "heuristic vs LLM routing" is really "do I trust the model to pick, or do I write the rules myself" — and on an emulated, unvalidated provider like Gemma, that trust needs an eval behind it before you lean on it.

## Primary diagram

```
  tool routing — buffr's degenerate case and the Case-B upgrade

  TODAY (1 tool)                          CASE B (2 tools — real routing)
  ──────────────                          ───────────────────────────────
  question                                question
    │ model.complete([search_kb schema])    │ model.complete([search_kb, list_docs])
    ▼                                       ▼
  {tool? } ── yes → search_knowledge_base  {tool: "?"} ── the NAME is the route
           └─ no  → answer                   │  ├─ "search_knowledge_base" → handlerA
                                             │  ├─ "list_documents"        → handlerB
  registry = [search_kb]                     │  └─ (none) → answer
  → no name to choose; routing degenerate  registry = [search_kb, list_docs]
                                            → model picks the name; eval proves it picks right
```

## Elaborate

Tool routing is where simple agents grow into orchestrators. At two or three tools, LLM routing usually holds. Past that, teams add a routing layer: a cheap classifier model that picks a *toolset* before the expensive model picks the exact tool, or a planner that decomposes the request into a sequence of tool-calls (that's `.aipe/study-agent-architecture/` territory). buffr is deliberately pre-routing — single-tool RAG — which is the right scope for a local-first profile assistant. The honest framing: there's no routing story to tell yet, only a routing *seam* that's ready. The day a second capability lands, this file's Case B becomes the work, and the eval that proves correct routing (`../05-evals-and-observability/01-eval-set-types.md`) becomes mandatory.

## Project exercises

> No curriculum file present; exercises derived from the codebase.

### Add a second tool to create a real routing decision

- **Exercise ID:** ROUTE-1 (Case B — routing not yet exercised). **The exercise that turns this file on.**
- **What to build:** a `list_documents` tool (returns indexed doc titles, no retrieval) registered alongside `search_knowledge_base`, so the model must route "list everything" to one and "what does X say" to the other.
- **Why it earns its place:** a single-tool agent can never demonstrate routing; two tools make LLM routing real, testable, and a talking point. Pairs with the routing eval below.
- **Files to touch:** new tool definition + handler, registered in `src/session.ts:44` (the `InMemoryToolRegistry` array + handler map).
- **Done when:** the model calls `list_documents` for "show me everything you know" and `search_knowledge_base` for a content question.
- **Estimated effort:** 1–2 days.

### Eval the routing decision per query type

- **Exercise ID:** ROUTE-2 (Case B — routing correctness measured).
- **What to build:** an eval set of (query → expected tool) pairs that runs the full `agent.answer()` and checks, via the trace's `tool_call_start` rows, that the model routed to the right tool.
- **Why it earns its place:** routing you can't measure is routing you can't trust — especially on Gemma's emulated tool-calls. This produces a routing-accuracy number.
- **Files to touch:** new eval set (e.g. `eval/routing.json`), a harness reading `agents.messages` tool-call rows (`src/supabase-trace-sink.ts:62`), reusing the agent build from `src/session.ts`.
- **Done when:** the eval reports routing accuracy and flags a misroute as a failure.
- **Estimated effort:** 1–4hr.

## Interview defense

**Q: Does buffr do tool routing?**
Answer: not meaningfully — it has one tool, `search_knowledge_base`, so the model's only choice is retrieve-or-answer, not which-tool. It's wired for LLM routing (the model would pick by emitting a tool name, and the registry dispatches by name), but with a one-entry registry there's nothing to route between. Routing turns on the moment a second tool is registered.

```
  registry = [search_kb] → choice is binary (retrieve | answer), not a route
```

**Q: If you added a second tool, what would you have to get right?**
Answer: two things the model can now get wrong — the *name* it picks (a routing error: wrong tool for the query) and the *args* it supplies (the existing unvalidated-args ceiling, now per-tool). LLM routing is only as reliable as the model, and Gemma's tool-calls are emulated and unvalidated, so I'd back the second tool with a routing eval — (query → expected tool) pairs scored against the trace's `tool_call_start` rows — before trusting it. **The part people forget: routing reliability is a cost you pay per tool, and it needs its own eval.**

```
  2 tools = 2 new failure modes: wrong NAME (route) + wrong ARGS (contract) → needs an eval
```

## See also

- `02-tool-calling.md` — the dispatch-by-name seam and the unvalidated-args ceiling routing inherits.
- `01-agents-vs-chains.md` — the loop that holds the (today degenerate) routing decision.
- `06-error-recovery.md` — a wrong-name route is recoverable; a wrong-arg call is not.
- `../05-evals-and-observability/01-eval-set-types.md` — the eval a second tool would need.
- `.aipe/study-agent-architecture/` — routing layers, planners, multi-tool orchestration.
