# Routing

*Industry names: **routing** / **dispatch** / **router pattern**. Type label: Industry standard. In this codebase: **minimal — one tool, no router.** (buffr's only "route" is the model's search-or-answer choice over a single tool — a degenerate route.)*

## Zoom out, then zoom in

Routing is the hinge between Section A (one agent picks a *tool*) and Section C (a supervisor
picks an *agent*). Here is where buffr's degenerate version sits.

```
  Routing — the hinge from A to C (★ = buffr's degenerate route)

  ┌─ SECTION A: single-agent — pick a TOOL ────────────────────┐
  │   ★ buffr ★  model decides: search_knowledge_base OR answer │
  │              ONE tool → the route is degenerate            │
  │              run-agent-loop.ts:131-135                     │
  └──────────────────────────┬─────────────────────────────────┘
                             │  SAME mechanism, more options
  ┌─ SECTION C: multi-agent — pick an AGENT ───────────────────┐
  │   supervisor decides: researcher? writer? critic?  (NOT YET)│
  └────────────────────────────────────────────────────────────┘
```

The verdict first: **buffr does not route between handlers — it has one agent and one
tool.** But the *mechanism* of routing is already present in miniature: every turn the model
chooses between "call the one tool" and "answer." This file teaches routing as that bridge —
in single-agent you route to a tool, in multi-agent you route to an agent, and it's the same
decision shape scaled up.

## Structure pass

One axis: **control** — how many destinations does the router choose between?

```
  Axis = CONTROL · the router's fan-out

  buffr today        2 destinations: {the one tool, answer}   ← degenerate route
  ─────── ★ SEAM: add a second tool and routing becomes REAL ★ ───────
  multi-tool agent   N tools: {search_db, web, calc, ...}     ← real tool routing
  multi-agent (C)    N agents: {researcher, writer, ...}      ← real agent routing
```

The seam is the *second destination*. With one tool, the model's only choice is "tool or
not" — there's nothing to route *between*. The moment you add a second tool (or a second
agent), the model must *select*, and you have a genuine router. buffr sits one tool short of
real routing — which is why this file calls it degenerate, not absent.

## How it works

### Move 1 — mental model

A router is a `switch` whose selector is a model decision. Bridge from frontend: it's exactly
a client-side route table — `switch(path) { case '/users': ... }` — except the model emits
the `path`. In single-agent the cases are tools; in multi-agent the cases are agents.

```
  THE SHAPE — routing is a model-selected switch

  input ──▶ ┌─ ROUTER (model decides) ─┐
            │  case "search":  tool A   │
            │  case "web":     tool B   │   ← buffr has only ONE case + "answer"
            │  case "calc":    tool C   │
            │  default:        answer   │
            └───────────────────────────┘
```

### buffr's degenerate route — search or answer over ONE tool

The route lives at the success-exit check. The model emits either a tool-use block (route to
the one tool) or no tool-use (route to "answer"). That's a two-way switch with a single
non-default case.

```ts
// run-agent-loop.ts:131-135 — the degenerate route. Two destinations, one of them the tool.
const toolUses = toolUsesFromContent(response.content);
if (toolUses.length === 0) {   // route = "answer"  (the default case)
  finalText = text;
  break;
}
// else: route = the one tool — there's nothing to choose BETWEEN, only whether
```

The tool catalog the router chooses from is filtered to exactly one entry by the capability
policy — so even if the model wanted another route, there isn't one.

```ts
// rag-query-agent.ts:14-18, 63-64 — capability scoping (ragQueryToolPolicy) → ONE tool offered
export const ragQueryToolPolicy: ToolPolicy = {
  capabilityId: RAG_QUERY_CAPABILITY_ID,
  allowedTools: [SEARCH_KNOWLEDGE_BASE_TOOL_NAME],   // ← exactly one destination
};
...
const toolSchemas = filterToolsForPolicy(allTools, ragQueryToolPolicy);  // catalog of size 1
```

```ts
// tool-policy.ts:11-23 — the filter that makes the route degenerate (size-1 allowlist)
export function filterToolsForPolicy(allTools, policy): ModelTool[] {
  const allowed = new Set(policy.allowedTools);
  return allTools.filter((tool) => allowed.has(tool.name)).map(...);  // → [search_knowledge_base]
}
```

Annotation: the router's case list is built by `filterToolsForPolicy`, and the policy admits
one tool. So buffr's "router" is a `switch` with a single case plus default. The
`minTopK:4` config on that tool (`session.ts:43`) means *when* the model does route to it,
the tool always returns at least four candidate chunks — so the single route is a wide one,
even though there's only one of it.

### The bridge — same mechanism, more cases = Section C

Scale the case list up and you walk straight into multi-agent. Add tools → multi-tool agent.
Replace tool-cases with agent-cases → supervisor routing.

```
  The bridge — buffr's route, scaled

  buffr (A)          add tools           multi-agent (C)
  ┌──────────┐       ┌──────────┐        ┌──────────────────┐
  │ search?  │  ──▶  │ search?  │   ──▶   │ → researcher     │
  │ answer   │       │ web?     │        │ → writer         │
  └──────────┘       │ calc?    │        │ → critic         │
   1 tool            │ answer   │        │ (supervisor picks)│
                     └──────────┘        └──────────────────┘
   degenerate         real tool route     real agent route
```

Annotation: the decision shape never changes — a model selecting from a catalog. What
changes is the catalog's contents (tools → agents) and size (1 → N). That's why routing is
the natural hinge between this section and Section C: master the size-1 route here and the
supervisor in C is the same `switch` with agents in the cases.

### Move 3 — the principle

**Routing is a model-selected switch; its difficulty scales with the number of cases, not
the mechanism.** buffr's route is degenerate (one tool) on purpose — the smallest catalog is
the smallest blast radius (capability scoping, Section D / `study-security`). When a real
second destination appears — a web tool, or a second agent — the *same* decision point
(`run-agent-loop.ts:131-135`) becomes a real router with no structural change. Don't add
routes you don't need; one tool, one route is a feature.

## Primary diagram

Full recap: buffr's degenerate route and the two scale-ups it bridges to.

```
  Routing — buffr's size-1 route as the A→C hinge

  ┌─ buffr TODAY: degenerate route ────────────────────────────┐
  │  model @ run-agent-loop.ts:131-135                         │
  │    tool_use? → search_knowledge_base   (the ONLY case)     │
  │    none?     → answer                   (default)          │
  │  catalog pinned to size 1 by ragQueryToolPolicy            │
  │    rag-query:14-18 · tool-policy:11-23 · minTopK:4 session:43│
  └──────────────────────────┬─────────────────────────────────┘
              add a 2nd tool  │  swap tools→agents
        ┌────────────────────┴────────────────────┐
        ▼                                          ▼
  real TOOL routing (A+)                  real AGENT routing (Section C)
  {search, web, calc, answer}            supervisor: {researcher, writer, ...}
```

Verdict in one line: **buffr has a degenerate single-tool route; the routing *mechanism* is
already there, and adding a second destination — tool or agent — is the bridge to real
routing and to Section C.**

## Elaborate

Routing is the simplest "agentic" pattern Anthropic's "Building Effective Agents" lists — a
classifier (often the model itself) directs input to one of several specialized handlers.
It's the workhorse of production LLM systems: route by intent, by difficulty (cheap model
vs expensive), by domain. buffr's degeneracy is deliberate — a single read-only tool is the
smallest possible attack surface and the simplest possible control flow, matching its
single-agent verdict. The interesting design question buffr defers is *router placement*:
when you do add destinations, does a separate cheap classifier route (explicit router) or
does the main model self-route via tool-choice (implicit router, what buffr does today)?
That trade — explicit vs implicit routing — is where Section B's retrieval-routing and
Section C's supervisor pick up.

Read next: Section C's "when NOT to go multi-agent" gate, then its topology catalogue —
which is this file's `switch` with agents in the cases.

## Interview defense

**Q: "Does buffr route requests? How would you add real routing?"**

Model answer: "Only degenerately. Every turn the model chooses between calling
`search_knowledge_base` and answering (`run-agent-loop.ts:131-135`) — but the tool catalog
is pinned to one entry by `ragQueryToolPolicy` and `filterToolsForPolicy`
(`rag-query-agent.ts:14-18`, `tool-policy.ts:11-23`), so there's nothing to route *between*.
It's a `switch` with one case plus default. The mechanism is already there: routing is just
a model-selected switch. To make it real I'd add a second destination — a web-search tool,
or in the multi-agent case a second agent — and the same decision point becomes a genuine
router with no structural change. I keep it size-1 today because the smallest catalog is the
smallest blast radius."

```
  The defense in one picture

  buffr: switch { tool → search; default → answer }   (1 case = degenerate)
  add a case ──▶ real tool route ──▶ swap to agents ──▶ Section C supervisor
```

Anchor: *Routing is a model-selected switch; buffr's is size-1 by design, and the second
destination is the bridge to multi-agent.*

## See also

- `01-chains-vs-agents.md` — the per-turn search-or-answer decision, framed as control flow.
- `02-agent-loop-skeleton.md` — the success-exit check (`:131-135`) that *is* the route.
- `../02-agentic-retrieval/` (Section B) — retrieval routing, the next routing flavor.
- `../03-multi-agent-orchestration/` (Section C) — the supervisor: this `switch` with agents.
- `study-security` → capability scoping as the size-1 allowlist that bounds the route.
