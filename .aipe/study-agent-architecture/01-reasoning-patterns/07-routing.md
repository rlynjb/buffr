# Routing — pick the right handler before committing to a loop

**Industry name(s):** routing · intent routing · dispatch ·
heuristic-then-LLM router. **Type label:** Industry standard.

**In this codebase: partially — at the tool layer, not the agent
layer.** buffr has no router that picks among agents or handlers
(there's one agent). But the loop *does* route at the smallest scale:
the model decides each turn between "call the search tool" and "answer
directly" (`run-agent-loop.js:54-57`). That binary search-or-answer
choice is routing collapsed to one tool. A real multi-source router is
the bridge to SECTION C.

## Zoom out, then zoom in

Routing is the bridge from single-agent reasoning to multi-agent
orchestration — the same pattern picks a tool in one system and an
agent in another.

```
  Zoom out — routing bridges SECTION A and SECTION C

  ┌─ Single-agent (buffr) ──────┐     ┌─ Multi-agent (SECTION C) ──┐
  │  router picks a TOOL        │ ──► │  router picks an AGENT     │
  │  (buffr: search vs answer)  │     │  (supervisor's core job)   │ ← we are here
  └─────────────────────────────┘     └────────────────────────────┘
```

Zoom in: routing decides *who handles this* before you commit to a
loop. The production shape is heuristic-first — cheap deterministic
rules for the high-volume predictable routes, an LLM router behind
them for the ambiguous ones.

## Structure pass

**Layers.** A router is a thin dispatch layer in front of the
handlers. In buffr there's no explicit router layer — the dispatch is
folded into the model's per-turn decision.

**Axis — "who decides which handler runs?"** Three answers, depending
on where you put routing: a regex/rule (deterministic), an LLM
classifier (model-decided), or — buffr's case — the agent itself
mid-loop (the model picks the tool as part of reasoning).

**Seam.** The router→handler boundary. In a multi-source system this is
where a query gets committed to vector-search vs SQL vs web. buffr has
only one handler, so the seam is degenerate (search or don't).

## How it works

#### Move 1 — the mental model

You've written a `switch` on a request type that dispatches to
different handlers. Routing is that switch, except the cases can be
fuzzy ("which of these did the user *mean*?") so you sometimes need a
model to classify before you can dispatch.

```
  Pattern — heuristic-first routing

  Input
    │
    ▼
  ┌─────────────────────┐
  │ Heuristic router    │  fast, deterministic
  │ (regex, rules)      │
  └─────────┬───────────┘
            │ no clear match
            ▼
  ┌─────────────────────┐
  │ LLM router          │  classify intent, pick
  │ (model-decided)     │  the handler/agent/tool
  └─────────────────────┘
```

#### Move 2 — the walkthrough

**buffr's routing is collapsed into the loop.** There's no front-door
router. Instead, every turn the model implicitly routes between two
options by what it emits (`run-agent-loop.js:53-57`):

```js
const toolUses = toolUsesFromContent(response.content);
if (toolUses.length === 0) {   // ROUTE: answer directly
  finalText = text;
  break;
}
// else ROUTE: call the search tool, observe, loop
```

That `if` is a router with two destinations: search, or answer. It's
the smallest possible routing — one tool plus the null route — and
it's the model that decides, every turn, with no deterministic
shortcut in front of it.

**Where a real router would go.** If buffr grew a second knowledge
source — say a SQL store of structured personal data alongside the
vector store of notes — it would need to route the query: semantic
question → vector search, exact lookup → SQL. That's the
retrieval-routing pattern (`02-agentic-retrieval/03-retrieval-routing.md`).
And if it grew a second *agent* — the phone "brain" in
`agent-layer-plan.md` — the router would pick which agent handles the
request, which is the supervisor's job in SECTION C.

```
  Layers-and-hops — routing today vs a would-be multi-source router

  TODAY (in-loop, 2 routes):        WOULD-BE (front-door router):
  ┌─ model turn ─┐                  ┌─ router ─┐
  │ search?      │ ── search ──►    │ classify │ ── semantic ─► vector
  │   or answer? │ ── answer        │ intent   │ ── exact ────► SQL
  └──────────────┘                  └──────────┘ ── fresh ────► web
```

#### Move 3 — the principle

Routing is the same pattern at every scale: pick the handler before
you commit to the work. In a single-agent system it picks a tool; in a
multi-agent system it picks an agent. The production shape puts cheap
heuristics in front of an LLM router so you only pay for classification
on the ambiguous traffic. buffr's single tool means its router is
trivially the model's own per-turn choice — correct for one handler,
the seed of a supervisor for many.

## Primary diagram

```
  Routing across the scales (buffr's place marked)

  ★ buffr: in-loop, 2 routes (search | answer) — model decides
       │ add a second source ─►  retrieval routing (vector|SQL|web)
       │ add a second agent  ─►  supervisor routing (pick an agent)
       ▼
  same pattern, bigger destinations
```

## Elaborate

Routing is where single-agent and multi-agent systems share a spine:
the supervisor in supervisor-worker
(`03-multi-agent-orchestration/02-supervisor-worker.md`) is, at its
core, a router plus a synthesizer. So learning routing here is
learning half of the most common multi-agent topology. The other
common form is retrieval routing, which is just routing applied to
"which knowledge source."

## Interview defense

**Q: Does buffr route requests?**
Only inside the loop, to one tool. Each turn the model routes between
"search the knowledge base" and "answer directly" — a two-destination
router collapsed into the ReAct decision (`run-agent-loop.js:54`).
There's no front-door router because there's one handler. The moment
buffr gets a second knowledge source or a second agent, that in-loop
choice becomes a real router.

```
  model turn → (search | answer)   ← routing with one tool
```

**Anchor:** "Routing is the same pattern at every scale — buffr picks
a tool, a supervisor picks an agent."

## See also

- `03-react.md` — where buffr's in-loop routing lives
- `02-agentic-retrieval/03-retrieval-routing.md` — routing over
  knowledge sources
- `03-multi-agent-orchestration/02-supervisor-worker.md` — routing
  scaled up to picking agents
