# Single-tool capability scope (allowlist policy)

**Industry name(s):** Least-privilege tool grant / capability allowlist /
tool policy · *Industry standard*

---

## Zoom out, then zoom in

Before the model sees a single tool schema, a policy filter decides which tools
it's even allowed to know exist. That filter is the agent's blast radius
control, and it sits right at the entrance to the loop.

```
  Zoom out — where the policy gate sits

  ┌─ Agent layer (aptkit) ────────────────────────────────────┐
  │  RagQueryAgent.answer:                                     │
  │     allTools = registry.listTools()   (everything wired)   │
  │     toolSchemas = ★ filterToolsForPolicy(allTools, policy)★│ ← we are here
  │                          │  allowlist = [search_kb]        │
  │                          ▼                                 │
  │     runAgentLoop(toolSchemas=...)   ← model only sees these│
  └────────────────────────────────────────────────────────────┘
```

Zoom in: `ragQueryToolPolicy.allowedTools` is exactly one entry —
`search_knowledge_base`, a read-only retrieval call. The agent cannot write,
cannot delete, cannot call out to the network, cannot touch anything but the
vector store. The smallest blast radius an agent can have while still being an
agent.

---

## Structure pass

**Axis: trust — what can this actor touch?**

```
  "what can each layer touch?" — traced inward

  ┌────────────────────────────────────────────┐
  │ registry: whatever buffr registers          │  → could be many tools
  └────────────────────────────────────────────┘
      ┌──────────────────────────────────────────┐
      │ policy filter: allowedTools = [search_kb] │  → exactly one
      └──────────────────────────────────────────┘
          ┌──────────────────────────────────────┐
          │ the tool itself: read-only pgvector    │  → no writes, no net
          └──────────────────────────────────────┘
```

**The seam:** the policy filter is a hard boundary between "what's available"
and "what's reachable." Trust narrows as you cross it — from "any registered
tool" to "one read-only tool." That narrowing is the whole point: the registry
can grow without widening the agent, because the allowlist is the gate, not the
registry.

---

## How it works

### Move 1 — the mental model

You know how a database role with `SELECT`-only grants can't drop a table no
matter what query you send it? Same idea: the agent's *grant* is one read-only
capability. Even a model that's been prompt-injected into "delete everything"
has nothing to call — the verb doesn't exist in its toolset.

```
  The pattern — allowlist intersection

  registry catalog        policy allowlist        what the model sees
  ┌──────────────┐        ┌──────────────┐        ┌──────────────┐
  │ search_kb    │        │ search_kb    │   ∩    │ search_kb    │
  │ (more, later)│   ∩    │              │   =    │              │
  └──────────────┘        └──────────────┘        └──────────────┘
       superset              the gate              least privilege
```

### Move 2 — the mechanism, part by part

**The policy object.** Bridge: it's a config constant, like a CORS allowlist or
a route guard's permitted-roles array. It names a capability id and the exact
tool names that capability may call. Nothing more.

```
  ragQueryToolPolicy = {
    capabilityId: 'rag-query-agent',
    allowedTools: [ 'search_knowledge_base' ],   ← one entry
  }
```

What breaks without it: the model sees every registered tool. Today that's
still one, but the contract is gone — the next person who registers a
`delete_document` tool just handed it to the model.

**The filter — intersection before the model sees anything.**
`filterToolsForPolicy` builds a `Set` from the allowlist and keeps only the
registry tools whose name is in it, mapping each to a provider-neutral schema.
This runs *before* `runAgentLoop`, so the disallowed tools never reach the
prompt.

```
  Layers-and-hops — filtering happens before the loop

  ┌─ registry ───┐ hop 1: listTools() → [search_kb]  ┌─ policy filter ─┐
  │ InMemory...  │ ───────────────────────────────►  │ filterTools...  │
  └──────────────┘                                    └───────┬─────────┘
                                              hop 2: schemas  │ (allowed ∩)
                                                              ▼
                                                       ┌─ runAgentLoop ─┐
                                                       │ model sees ONLY│
                                                       │ search_kb      │
                                                       └────────────────┘
```

What breaks without the intersection: even with a policy object, if you handed
the model `allTools` directly the allowlist would be decoration. The filter is
where the policy becomes enforcement.

**The tool is read-only.** The one allowed capability queries pgvector and
returns ranked chunks. No write path, no side effect. So even the *granted*
capability can't mutate state.

### Move 3 — the principle

Capability scoping is enforced at the *grant*, not the *prompt*. Telling the
model "don't do bad things" in the system prompt is a suggestion; removing the
tool from its toolset is a guarantee. The allowlist is the difference between a
request and a contract — and the read-only nature of the one granted tool means
the worst case is a wasted search, not a mutation.

---

## Primary diagram

```
  Single-tool scope — full recap

  ┌─ buffr wiring (session.ts:44) ─────────────────────────────┐
  │  registry = InMemoryToolRegistry([ search_kb.definition ]) │
  └───────────────────────────┬───────────────────────────────┘
                              │ listTools()
  ┌─ aptkit policy (rag-query-agent.js:37) ───▼────────────────┐
  │  toolSchemas = filterToolsForPolicy(                       │
  │     allTools, ragQueryToolPolicy)                          │
  │  ragQueryToolPolicy.allowedTools = ['search_knowledge_base']│
  └───────────────────────────┬───────────────────────────────┘
                              │ schemas (exactly one)
  ┌─ the loop ────────────────▼────────────────────────────────┐
  │  model may emit ONLY: tool_use{ search_knowledge_base }     │
  │  → read-only pgvector query, no writes                     │
  └─────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

### Use cases

Reached on every agent run, invisibly. The user never picks tools; the policy
fixes the toolset to one read-only capability for all questions. It's the
control that lets buffr index untrusted content (anyone's markdown) without
that content being able to coerce the agent into a destructive action — there's
no destructive action to coerce it into.

### Code, side by side

The policy (`@aptkit/agent-rag-query/dist/src/rag-query-agent.js:8-11`):

```
export const ragQueryToolPolicy = {
  capabilityId: RAG_QUERY_CAPABILITY_ID,        ← 'rag-query-agent'
  allowedTools: [SEARCH_KNOWLEDGE_BASE_TOOL_NAME], ← exactly one: 'search_knowledge_base'
};
        │
        └─ change THIS array to widen the agent's reach — nothing else.
           The registry growing doesn't widen it; the allowlist is the gate.
```

The filter (`@aptkit/tools/dist/src/tool-policy.js:2-11`):

```
export function filterToolsForPolicy(allTools, policy) {
  const allowed = new Set(policy.allowedTools);    ← O(1) membership
  return allTools
    .filter((tool) => allowed.has(tool.name))      ← intersection: keep allowed
    .map((tool) => ({ name, description, inputSchema })); ← provider-neutral schema
}
        │
        └─ runs in answer() BEFORE runAgentLoop — disallowed tools never reach
           the prompt, so the model can't even hallucinate calling one usefully.
```

The grant in buffr (`src/session.ts:43-44`):

```
const tool = createSearchKnowledgeBaseTool(pipeline, { minTopK: 4 });
const tools = new InMemoryToolRegistry(
  [tool.definition],                               ← one definition registered
  { [tool.definition.name]: tool.handler });       ← one handler
        │
        └─ buffr registers exactly one tool, so registry ∩ allowlist = the tool.
           The policy is still load-bearing: it's the contract, not the count.
```

---

## Elaborate

This is the agent-architecture face of a security principle covered in depth in
`.aipe/study-security/04-least-privilege-tool-scope.md` — read that for the
threat model (prompt injection via indexed content → coerced tool call) and
why a read-only single tool collapses the attack surface. This file's job is
placement: the allowlist is *where capability scoping lives in the agent loop*,
the gate between the registry and the prompt.

The pattern generalizes to multi-tool and multi-agent systems: each capability
(or each agent) gets its own allowlist, and the supervisor's allowlist is
different from a worker's. buffr exercises the degenerate case — one capability,
one tool — which is the right place to start. `06-orchestration-templates.md`
shows what the allowlist looks like when the agent grows write tools and needs
action gating.

---

## Interview defense

**Q: How do you stop a prompt-injected model from doing damage?**
I don't rely on the prompt. The agent's tool grant is an allowlist of one read-only tool — `filterToolsForPolicy` intersects the registry with `allowedTools` before the model sees any schema. There's no write tool to call, so injected instructions have nothing to actuate.

```
  prompt says "be safe"     → suggestion
  toolset has no write verb  → guarantee
```
Anchor: "Scope at the grant, not the prompt."

**Q: Your registry only has one tool. Why bother with a policy?**
Because the policy is the contract and the registry is an implementation detail. The day someone registers a second tool, the allowlist is what stops it reaching the model automatically. Without the policy, registry growth silently widens the agent.
Anchor: "The allowlist is the gate; the registry is just inventory."

---

## Validate

1. **Reconstruct:** Write `ragQueryToolPolicy` from memory and the one-line
   filter logic. (`rag-query-agent.js:8-11`, `tool-policy.js:2-11`.)
2. **Explain:** Why does filtering happen in `answer()` before `runAgentLoop`
   rather than inside the loop? (Disallowed schemas never reach the prompt.)
3. **Apply:** You add a `delete_document` tool to the registry but forget to
   touch the policy. Can the agent call it? (No — not in `allowedTools`.)
4. **Defend:** Argue why read-only single-tool scope is the right default for a
   RAG agent over untrusted indexed content.
   (`.aipe/study-security/03-indirect-prompt-injection-surface.md`.)

---

## See also

- `01-bounded-react-loop.md` — the loop these schemas feed
- `05-emulated-tool-calling.md` — how the one tool is rendered to Gemma
- `audit.md` — Lens 6 (capability scoping)
- `.aipe/study-security/04-least-privilege-tool-scope.md` — the threat model
- Tool-calling mechanics (sibling generator): `.aipe/study-ai-engineering/04-agents-and-tool-use/02-tool-calling.md`

---

Updated: 2026-06-24 — Pattern unchanged; re-pointed tool-registry wiring refs
from the deleted `ask-cmd.ts` to `src/session.ts:43-44` (the long-lived chat
session). Allowlist policy and one-read-only-tool scope are identical.
