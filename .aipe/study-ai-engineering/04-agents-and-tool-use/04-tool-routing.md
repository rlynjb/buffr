# Tool Routing — Picking the Tool (When There's Only One)
### *Heuristic vs LLM routing, and why buffr's real routing is gather-vs-synthesize*
**Type label:** agent dispatch (tool selection)

## Zoom out

Routing is the decision *which* tool to call. Find it in the stack: it sits between the loop wanting to act and the registry executing.

```
The routing decision in the stack
┌──────────────────────────────────────────────────────────┐
│  Agent loop        wants to act                             │
├──────────────────────────────────────────────────────────┤
│  ★ ROUTING         which tool? + should I act at all?       │  ← this file
│     heuristic:  "always call search first" (system prompt) │
│     LLM:        model emits {"tool": "..."}                 │
│     gate:       act vs synthesize (the real decision)      │
├──────────────────────────────────────────────────────────┤
│  Tool registry     callTool(chosen, input)                  │
└──────────────────────────────────────────────────────────┘
```

In a multi-tool agent, ★ is a hard problem: the model has to pick the *right* tool from many, and picking wrong wastes a turn or produces nonsense. buffr makes ★ trivial on the "which tool" axis — there is exactly one tool — and that's the honest headline of this file. The interesting routing in buffr isn't *which tool*; it's *whether to act or answer*.

Conversational version. You've written a router before — `switch (route) { case '/users': ...; case '/posts': ... }`. Tool routing is the same `switch`, except the *cases* are tools and the *selector* is either a fixed rule you wrote (heuristic) or a value the model produces at runtime (LLM-decided). buffr's `switch` has one case. So the routing question collapses: not "which branch" but "do we take the branch at all, or fall through to the answer?"

## Structure pass

The axis: **who picks the tool — a fixed rule or the model?** Most agents blend both.

```
The routing axis
   HEURISTIC                                         LLM-DECIDED
   (rule you wrote)                                  (model emits choice)
   ├─────────────────────────────────────────────────────────────┤
   "always search first"          buffr uses BOTH        "model picks from N tools"
   system-prompt nudge                  ▲                free-form selection
                                        │
                             one tool → the WHICH is trivial
```

buffr uses both mechanisms — but because there's one tool, both reduce to "call search or don't." The genuinely interesting routing seam is elsewhere: the gather→synthesize gate. *That's* the branch that actually changes behavior.

```
Where buffr's routing actually decides something
  ┌─ trivial: WHICH tool ────────────────────────────────────┐
  │  policy allows exactly [search_knowledge_base]            │  one case
  │  heuristic: "always call search first"                    │  always same case
  └───────────────────────────────────────────────────────────┘
  ┌─ REAL: act vs answer ────────────────────────────────────┐
  │  forceFinal?  → tools stripped → synthesize                │  ← the live branch
  │  else         → model may emit a search call               │
  └───────────────────────────────────────────────────────────┘
```

## How it works

### Move 1 — the mental model

Routing has two questions stacked: *should I act?* and *if so, which tool?* buffr answers the second trivially (one tool) and spends all its real decision-making on the first.

```
The two routing questions
  Q1: act at all?         ← the live decision in buffr (forceFinal gate)
       │ yes
       ▼
  Q2: which tool?         ← trivial in buffr (only search_knowledge_base)
       │
       ▼
  callTool(search_knowledge_base, input)
```

### Move 2 — step by step

#### Heuristic routing: the "always search first" nudge

Bridge from what you know: a default route. You've written `app.get('*', () => redirect('/home'))` — a catch-all that biases every request toward one handler unless something overrides. The system prompt is that catch-all bias, applied to tool choice.

```
Heuristic: bias the model toward search before it reasons
  system prompt:
    "Always call the search_knowledge_base tool first to retrieve
     relevant passages before answering."
     │ shapes the model's first move
     ▼
  model's turn-0 default: emit a search call
```

Real code, `aptkit packages/agents/rag-query/src/rag-query-agent.ts:20`:

```ts
const DEFAULT_SYSTEM_TEMPLATE = [
  'You are a personal knowledge assistant.',
  '',
  `Always call the ${SEARCH_KNOWLEDGE_BASE_TOOL_NAME} tool first to retrieve relevant`,
  'passages before answering. Ground every answer in the retrieved chunks and cite',
  'their sources. If the knowledge base does not contain the answer, say so plainly',
  'rather than guessing.',
].join('\n');
```

The consequence: this is a *soft* heuristic. It's a prompt instruction, not enforced code — the model can ignore it (and a weak model sometimes does, answering from its own weights without searching). It biases, it doesn't guarantee. That's worth saying plainly: "always search first" is a hope expressed in English, backed by no runtime check.

#### LLM routing: the model emits the choice

Bridge: a runtime-computed route, like reading the target from a payload — `routes[req.body.action]`. The model produces the tool name; your code dispatches on it. Same as `02-tool-calling.md`, viewed as a routing decision.

```
LLM routing: the model names the tool
  model emits {"tool": "search_knowledge_base", "arguments": {...}}
     │ parseToolCall → name
     ▼
  callTool(name, input)   ← dispatch on the model's chosen name
```

The dispatch itself is in the registry, but the policy is what makes routing *safe*. The least-privilege filter means even if the model hallucinates a different tool name, it was never offered. Real code, `aptkit packages/agents/rag-query/src/rag-query-agent.ts:15` and `:63`:

```ts
export const ragQueryToolPolicy: ToolPolicy = {
  capabilityId: RAG_QUERY_CAPABILITY_ID,
  allowedTools: [SEARCH_KNOWLEDGE_BASE_TOOL_NAME],    // ← the ONLY routable destination
};
// ...
const allTools = await this.options.tools.listTools();
const toolSchemas = filterToolsForPolicy(allTools, ragQueryToolPolicy);   // ← model only SEES one tool
```

The consequence: the routing space is closed at the policy layer. The model can only route to tools it was shown, and it was shown exactly one. A hallucinated tool name from the model would simply fail to match anything real — there's no second tool to mis-route to.

#### The real routing: gather vs synthesize (`forceFinal`)

Bridge: the actual `if` that changes behavior. With one tool, "which tool" never branches. The branch that *does* is whether the model gets to act at all — and that's `forceFinal`, the same gate from `03-react-pattern.md`, seen now as a routing decision.

```
The live branch: route to a tool, or route to the answer
  forceFinal = lastTurn OR budgetSpent
     ├─ false → model.complete(tools: schemas)   → may route to search
     └─ true  → model.complete(tools: undefined) → routes to SYNTHESIS only
```

Real code, `aptkit packages/runtime/src/run-agent-loop.ts:101`:

```ts
const forceFinal = turn === maxTurns - 1 || budgetSpent;
const response = await model.complete({
  system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
  messages,
  tools: forceFinal ? undefined : toolSchemas,   // ← THE routing decision that matters: tool path or answer path
  maxTokens,
  signal,
});
```

The consequence: in a one-tool agent, the only routing decision with two real outcomes is "tool path vs answer path." That's `forceFinal`. Calling it "the real routing" isn't a rhetorical flourish — it's the only place in buffr where the dispatch genuinely forks.

### Move 2.5 — current vs future

```
Routing complexity (current ✗ trivial / future ✓ real)
  ✗ current:  N = 1 tool. "which tool" never branches.
              routing = heuristic nudge + LLM call, both → search.
  ✓ future:   N = 2+ tools (e.g. + a structured profile lookup, + a web fetch).
              now "which tool" is a live decision the model can get WRONG.
              routing becomes a real classification problem with real failure modes.
```

The instant buffr gains a second tool, this entire file changes character. With two tools, the model can route to the wrong one, and you discover all the multi-tool routing problems at once: ambiguous queries, the model picking the cheap tool over the right tool, needing to call two tools in sequence. Today none of that exists, and pretending it does would be dishonest. The exercise below is how you make routing real.

### Move 3 — the principle

Routing complexity scales with the *number* of tools and the *overlap* in what they do. buffr sits at the floor: one tool, zero overlap, trivial routing. The lesson isn't "buffr's routing is simple" — it's that *with one tool, the routing problem moves up a level*, from "which tool" to "tool or no tool." Always find the decision that actually forks. Here it's `forceFinal`.

## Primary diagram

Routing in buffr, both axes, with the trivial one and the live one marked.

```
buffr routing: one trivial axis, one live axis
  question
     │
  ┌─ Q1: act or answer?  (LIVE — forceFinal) ─────────────────┐
  │     forceFinal?                                            │
  │       true  ──────────────────────────► SYNTHESIZE         │
  │       false ─┐                                             │
  └──────────────┼─────────────────────────────────────────────┘
                 ▼
  ┌─ Q2: which tool?  (TRIVIAL — one case) ───────────────────┐
  │     policy: allowedTools = [search_knowledge_base]         │
  │     heuristic: "always search first"                       │
  │     LLM: model emits {"tool":"search_knowledge_base"}      │
  │       └──────────────► callTool(search_knowledge_base)     │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

There's a subtle reason one tool is the *right* number for buffr today, not a placeholder. The product is "answer questions from my personal corpus." That is one capability: retrieve and ground. A second tool would have to earn its place by enabling a question buffr can't answer now — a calculation, a live web fact, a structured profile field that isn't in the embedded corpus. Until such a question exists, a second tool only adds routing failure modes with no new capability. The honest move is to keep routing trivial until a real need forces it open — which is exactly when the exercise below pays off.

Also worth noting: the least-privilege policy (`filterToolsForPolicy`) is doing security work even with one tool. It's the seam where, when you *do* add tools, you decide which capability may route to which. A future "summarize" agent and a future "search" agent can share a registry but route to disjoint tool sets. The policy is the routing *authorization* layer, separate from the routing *decision* layer. It's built for N tools even though N is currently 1.

## Project exercises

### Add a second tool and make routing a real decision

- **Exercise ID:** [B4.7], Phase 4 (the primary exercise for this concept — Case B: meaningful routing does not exist yet; this builds it).
- **What to build:** Add a second tool — the cleanest candidate is a structured `lookup_profile` tool that returns fields from `me.md` directly rather than via embedding search — register it, add it to `ragQueryToolPolicy.allowedTools`, and update the system prompt to describe *when* to use each. Then observe the model routing (and mis-routing) between them.
- **Why it earns its place:** This is the single change that converts buffr's trivial routing into a real classification problem. You'll immediately hit the multi-tool failure modes — ambiguous queries, the model preferring search even when profile lookup is right — and you'll need the trace to diagnose them. It's the difference between *describing* routing and *having* it.
- **Files to touch:** new tool in `buffr src/` (e.g. `src/profile-tool.ts`) or `aptkit packages/tools/`, `buffr src/session.ts` (register the second tool in `InMemoryToolRegistry`), `aptkit packages/agents/rag-query/src/rag-query-agent.ts` (policy `allowedTools` + system prompt routing guidance).
- **Done when:** A question like "what's my email?" routes to `lookup_profile` while "what did I read about X?" routes to `search_knowledge_base`, both visible in the trace, with at least one eval case per route.
- **Estimated effort:** 4–6 hours.

### Enforce the "always search first" heuristic instead of merely prompting it

- **Exercise ID:** [B4.8], Phase 4.
- **What to build:** Convert the soft "always call search first" prompt instruction into a code guarantee: on turn 0, if the model emits prose instead of a search call, reject it and force a search before allowing an answer.
- **Why it earns its place:** Today "always search first" is English, not enforcement — a weak model can skip retrieval and answer from its weights, which is the exact ungrounded-answer failure RAG exists to prevent. Promoting the heuristic from prompt to code closes that gap and teaches the difference between a nudge and a guarantee.
- **Files to touch:** `aptkit packages/runtime/src/run-agent-loop.ts` (or a wrapper in `RagQueryAgent.answer`) to require a tool call before accepting a turn-0 final.
- **Done when:** A turn-0 prose answer triggers a forced search instead of being returned, verified by a test where the model is scripted to answer without searching.
- **Estimated effort:** 2–3 hours.

## Interview defense

**Q: "How does your agent route between tools?"**

Honestly — it doesn't have to, yet. There's exactly one tool, `search_knowledge_base`, locked in by a least-privilege policy. So "which tool" never branches: the heuristic ("always search first" in the system prompt) and the LLM call (model emits the tool JSON) both resolve to the same single tool. The policy filter means the model can't even *see* another tool to route to.

```
  policy → [search_knowledge_base]  →  every route lands here
```

*Anchor: with one tool, "which tool" is a constant — the routing decision moves up a level.*

**Q: "Then what's the real routing decision?"** — the part people forget.

Act vs answer. The only place dispatch genuinely forks is `forceFinal`: when the turn or tool-call budget is spent, the loop routes to *synthesis* by stripping the tools (`tools: undefined`); otherwise it routes to the *tool path* and the model may search. People look for routing in "which tool" and miss that, in a one-tool agent, the live routing decision is whether to call a tool at all. The moment a second tool is added, "which tool" becomes a real classification problem — but today the forced-final gate is the routing that matters.

```
  forceFinal → synthesize | else → tool path  ← the only real fork
```

*Anchor: in a one-tool agent the routing that forks is gather-vs-synthesize, not tool selection.*

## See also

- **`02-tool-calling.md`** — how the LLM's tool choice is emitted and parsed (and not validated).
- **`03-react-pattern.md`** — `forceFinal` as the gather→synthesize gate, here re-read as routing.
- **`01-agents-vs-chains.md`** — `filterToolsForPolicy` and least-privilege as the routing authorization layer.
- **`../03-retrieval-and-rag/`** — what the single routed tool does once selected.
