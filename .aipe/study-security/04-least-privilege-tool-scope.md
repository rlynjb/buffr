# Least-privilege tool scope

**Industry name(s):** least-privilege agent / tool allowlisting /
capability scoping. **Type:** Industry standard (security principle
applied to agent tools).

## Zoom out, then zoom in

The agent can be talked into anything by a hijacked prompt — but it can
only *do* what's in its tool allowlist, and that allowlist holds
exactly one entry: a read-only knowledge-base search. Plus a hard
budget (6 turns, 4 tool calls) the loop physically can't exceed. This
is the control that makes every other "what if the model is
compromised" question end in "...then it searches the knowledge base
and stops."

```
  Zoom out — where the tool scope is enforced

  ┌─ Provider (Ollama gemma2) ──────────────────────────────────────┐
  │  model PROPOSES tool calls (could ask for anything)              │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ proposed call
  ┌─ Service (agent loop) ────▼──────────────────────────────────────┐
  │  ★ filterToolsForPolicy: allowlist = [search_knowledge_base] ★   │ ← we are here
  │  runAgentLoop: maxTurns 6 · maxToolCalls 4 (forced final)        │
  └───────────────────────────┬──────────────────────────────────────┘
                              │ only the allowed, read-only tool runs
  ┌─ Storage (Postgres) ──────▼──────────────────────────────────────┐
  │  vector search (read) — no write/exec/egress reachable           │
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is *least privilege* — grant the smallest set of
capabilities the task needs, deny everything else by default. The thing
to understand is that this is enforced in **two independent places**:
what tools the model is even *offered* (the allowlist), and how many
times it can call them (the budget). Either one alone helps; together
they make a hijacked agent inert. This is the single strongest security
control in buffr, and it's worth knowing it lives in aptkit, injected
by buffr's choice to register only one tool.

## The structure pass

**Layers:** provider (proposes) → agent loop (filters + budgets) →
storage (executes the one read-only tool). Control flows down; the
filter sits in the middle.

**Axis — control.** Trace "who decides what the agent can do?":

```
  axis traced = "who decides what runs?"

  ┌─ model side ─────────┐  seam: the policy   ┌─ loop side ─────────┐
  │ model PROPOSES any   │ ════════╪══════════► │ loop ALLOWS only    │
  │ tool it wants        │  (it flips HARD)     │ allowlisted tools   │
  └──────────────────────┘                      └─────────────────────┘
       ▲                                              ▲
       └──── control flips at the policy seam ────────┘
             model: "I want X"   loop: "only if X ∈ allowlist"
```

**Seam:** `filterToolsForPolicy` — the policy gate. Control flips here:
the model *proposes*, the loop *disposes*. Unlike `02`'s tenant seam
(where trust didn't flip), this seam is load-bearing — it's the joint
the whole agent-security story hangs on. And there's a second seam in
series: the turn/tool-call budget inside `runAgentLoop`, which caps
*how long* control stays with the model.

## How it works

You know this from filesystem permissions: a process runs as a user
that can only touch certain files — not because the process is trusted,
but because the OS won't let it reach the rest. Same move here, applied
to agent tools: the model isn't trusted, the loop just won't offer it
anything but search.

```
  The pattern — propose / filter / budget

   model proposes        policy filters         budget caps
   ┌─────────────────┐   ┌──────────────────┐   ┌──────────────────┐
   │ "call tool X"   │──►│ X ∈ allowlist?   │──►│ calls < 4?       │
   │  (any name)     │   │  yes: run it     │   │  yes: run        │
   │                 │   │  no:  not offered│   │  no:  force final│
   └─────────────────┘   └──────────────────┘   └──────────────────┘
        anything             ONE tool only          ≤4 times, ≤6 turns
```

### The kernel — three parts, name what breaks without each

1. **The policy declaration** — the allowlist. `ragQueryToolPolicy =
   { allowedTools: [SEARCH_KNOWLEDGE_BASE_TOOL_NAME] }`
   (`@aptkit/agent-rag-query`). Comment in the source:
   *"Least-privilege grant: this agent may only search the knowledge
   base."* *Breaks if missing:* no statement of what's allowed — the
   model is offered every registered tool.
2. **The filter that enforces it** — `filterToolsForPolicy` builds
   `new Set(policy.allowedTools)` and `.filter(t => allowed.has(t.name))`
   (`@aptkit/tools` `tool-policy.js`). RagQueryAgent runs it before the
   loop. *Breaks if missing:* the policy is just a comment; the model
   sees the whole catalog.
3. **The budget that bounds runtime** — `runAgentLoop`'s
   `for (let turn = 0; turn < maxTurns; turn++)` plus
   `budgetSpent = toolCalls.length >= maxToolCalls` →
   `forceFinal` (`@aptkit/runtime` `run-agent-loop.js:25,27,28`).
   RagQueryAgent passes `maxTurns: 6, maxToolCalls: 4`. *Breaks if
   missing:* a hijacked or looping model spins forever / fans out
   unbounded tool calls.

All three are load-bearing. Drop 1 or 2 and scope is unenforced; drop 3
and scope is enforced but unbounded.

### The allowlist — read the enforcement

The policy is a declaration (`@aptkit/agent-rag-query`):

```
  export const ragQueryToolPolicy = {
    capabilityId: RAG_QUERY_CAPABILITY_ID,
    allowedTools: [SEARCH_KNOWLEDGE_BASE_TOOL_NAME],   ◄ exactly one tool
  };
```

The enforcement is a default-deny filter (`@aptkit/tools`
`tool-policy.js`):

```
  export function filterToolsForPolicy(allTools, policy) {
    const allowed = new Set(policy.allowedTools);          ◄ allowlist as a Set
    return allTools
      .filter((tool) => allowed.has(tool.name))            ◄ deny-by-default: not in
      .map((tool) => ({ name, description, inputSchema })); ◄ set → never offered
  }
```

Default-deny is the load-bearing detail: a tool the model could call
is one the loop chose to *offer*. Anything not in the allowlist isn't
"blocked when called" — it's never presented, so the model can't even
name it.

### buffr's half — register only what's granted

aptkit enforces the policy, but buffr decides what's in the registry to
begin with (`src/session.ts:43-44`):

```
  const tool = createSearchKnowledgeBaseTool(pipeline, { minTopK: 4 });
  const tools = new InMemoryToolRegistry(
    [tool.definition],                          ◄ ONE tool registered, period
    { [tool.definition.name]: tool.handler });
```

Two layers of least privilege stack here: buffr registers exactly one
tool, *and* the policy allowlists exactly that one. Even if buffr
registered more, the policy would filter them out — but buffr doesn't
even tempt it. And the one tool is **read-only**: a vector search
(`src/pg-vector-store.ts:67`). There is no write tool, no shell tool,
no HTTP tool, no file tool anywhere in the registry.

### Why this caps every other finding

This is the control that downgrades the prompt-injection surface (`03`)
from "breach" to "wrong answer." Walk it: a poisoned passage tells the
model to exfiltrate data. The model proposes a tool call to do it.
There's no such tool in the allowlist — it was never offered. The model
proposes searching again. Fine, but the budget caps it at 4 calls,
then forces a final answer. The hijack spends itself against a wall.
Strip this control out and `03` becomes severe; keep it and `03` stays
low.

### The principle

Least privilege is the one security control that *compounds* — it makes
every other weakness less exploitable without knowing what the weakness
is. You don't have to enumerate the attacks; you enumerate the
*capabilities* and grant the minimum. For agents specifically: scope
the tool set to the task, deny by default, and bound the loop. An agent
whose tools exceed its task is the agent-era version of running
everything as root.

## Primary diagram

The full control: declaration, enforcement, budget, and the read-only
floor.

```
  Least-privilege tool scope — buffr-laptop

  ┌─ Provider (Ollama gemma2) ──────────────────────────────────────┐
  │  proposes tool calls — UNtrusted, could ask for anything         │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ proposed call name
  ┌─ Service (agent loop, aptkit) ───────────────────────────────────┐
  │  1. policy:  allowedTools = [search_knowledge_base]              │
  │  2. filter:  new Set(...).has(name)  — default-deny              │
  │  3. budget:  maxTurns 6 · maxToolCalls 4 → forceFinal           │
  │  buffr registers ONE tool (session.ts) — read-only               │
  └───────────────────────────┬──────────────────────────────────────┘
                              │ only search runs, ≤4 times
  ┌─ Storage (Postgres) ──────▼──────────────────────────────────────┐
  │  vector search (READ). No write / exec / egress reachable.        │
  │  → hijacked model's worst case: search, then stop                 │
  └──────────────────────────────────────────────────────────────────┘
```

## Elaborate

Least privilege is the oldest principle in security — Saltzer & Schroeder,
1975 — and it transfers cleanly to agents because an agent's "syscalls"
are its tools. The agent-era failure mode is giving a model a broad
toolbelt "to be helpful" (write-to-DB, send-email, run-code) and
relying on the prompt to keep it in line; prompts are not a security
boundary, tool scope is. buffr's version is unusually tight: one
read-only tool. That's partly the phase (a RAG query agent genuinely
needs only search) and partly discipline (the policy + filter would
hold even if more tools existed). The budget is the often-forgotten
half — a correctly-scoped agent with an unbounded loop can still burn
your token budget or hammer the DB; `maxToolCalls: 4` is the part that
signals "built it, didn't just read about it."

The control-flow mechanics of `runAgentLoop` — the forced-synthesis
final turn, the recovery turn — are an agent-architecture topic; this
file owns the *security* read (scope + budget as a defense). The deep
loop walk belongs in that guide when it's generated.

## Interview defense

**Q: How do you keep your agent from doing something dangerous if the
prompt gets hijacked?**

I don't trust the model — I scope its capabilities. The agent has an
allowlist with exactly one tool, a read-only knowledge-base search,
enforced by a default-deny filter: a tool not in the allowlist is never
even offered to the model. Plus a hard budget — max 6 turns, max 4 tool
calls — so it can't loop or fan out. A hijacked prompt can make the
model *want* to do something bad; there's no tool that *does* anything
bad, so the worst case is a wrong answer.

```
  model proposes anything → allowlist offers ONE read-only tool
  → budget caps it at 4 calls → hijack hits a wall
```

Anchor: *prompts aren't a security boundary; tool scope is. Deny by
default, bound the loop.*

**Q: What's the load-bearing part people forget?**

The budget. Everyone scopes the tool *set* and forgets to bound the
*loop*. `maxToolCalls: 4` with a forced final answer is what stops a
correctly-scoped agent from still spinning forever or hammering the DB.
Scope plus budget — both, or it's only half the control.

Anchor: *least privilege without a loop budget is half a control.*

## See also

- `audit.md` — lens 7 (llm-and-agent-security), where this is the
  strongest control found.
- `03-indirect-prompt-injection-surface.md` — the surface this control
  caps from breach to wrong-answer.
- `02-shape-only-tenant-isolation.md` — the other "control sized to the
  phase" decision; both turn up when the agent gains a write tool.
- `../study-system-design/` — the agent loop + tool registry
  architecture.
