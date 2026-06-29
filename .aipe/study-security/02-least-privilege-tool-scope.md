# Least-privilege tool scope

**Industry name:** least privilege / capability-scoped tool allowlist (the
`ragQueryToolPolicy` grant). *Industry standard* (security principle) applied to
*agent architecture*.

## Zoom out, then zoom in

An LLM agent is only as dangerous as the tools you hand it. The question this
pattern answers: of all the things the runtime *could* let the model do, which can
it actually reach? Here's the answer's location.

```
  Zoom out — where the tool grant sits

  ┌─ Service layer ──────────────────────────────────────────┐
  │  ChatSession builds the agent (src/session.ts:43-57)      │
  │  registry holds: [ search_knowledge_base ]                │
  └───────────────────────────────┬──────────────────────────┘
                                  │  agent.answer(question)
  ┌─ Agent (aptkit) ──────────────▼──────────────────────────┐
  │  ★ ragQueryToolPolicy ★  allowedTools: [search_kb]        │ ← we are here
  │  filterToolsForPolicy() → only allowlisted schemas to LLM │
  │  loop bounded: maxTurns 6 / maxToolCalls 4                │
  └───────────────────────────────┬──────────────────────────┘
                                  │  the ONE tool it can call
  ┌─ Storage ─────────────────────▼──────────────────────────┐
  │  search_knowledge_base → pipeline.query → SELECT (read)   │
  └───────────────────────────────────────────────────────────┘
```

The pattern (least privilege) is the oldest principle in security: give a component
exactly the authority its job requires and not one capability more. Applied to an
agent, it means the model's reachable tool set is an explicit allowlist — not "every
tool registered," but "the one tool this capability is for." Here that's a single
read-only search. This is the control that makes the next file's injection surface
survivable: a hijacked agent has nothing dangerous to reach for.

## The structure pass

**Layers:** the registry (what tools exist) → the policy filter (what *this* agent
may see) → the bounded loop (how many times it may act) → the tool handler (a
read-only SELECT).

**The axis to trace: trust / authority.** "What can the model cause to happen?"
Hold it down the layers:

```
  One axis — "what can the model cause?" — traced down

  ┌─ registry ──────────┐   could hold any tools (write, shell, fetch)
  │  full catalog       │   → authority: whatever's registered
  └──────────┬──────────┘
             │  seam: filterToolsForPolicy(allowlist)
  ┌─ policy ─▼──────────┐  model SEES only search_knowledge_base
  │  one tool           │  → the flip: authority collapses to "read"
  └──────────┬──────────┘
             │  seam: maxToolCalls 4 / maxTurns 6
  ┌─ loop ───▼──────────┐  even that read, at most 4 times
  │  bounded            │  → authority: read, finitely
  └──────────┬──────────┘
             ▼
  ┌─ handler ───────────┐  SELECT only — no write path exists
  │  read-only          │  → authority: observe, never mutate
  └─────────────────────┘
```

Two seams flip the authority answer: the policy filter (collapses many → one) and
the call budget (collapses unbounded → finite). Those two joints are the whole
control.

## How it works

### Move 1 — the mental model

You know how a React component only gets the props you pass it — it can't reach into
sibling state it wasn't handed? Same shape: the model only gets the tool schemas the
policy passes it. Anything not on the allowlist is invisible — the model can't call
a tool it was never shown.

```
  The pattern — allowlist as a one-way gate

  registry: [ search_kb, (hypothetically: write, shell, http) ]
                  │
          filterToolsForPolicy(allowedTools: [search_kb])
                  │   keeps only names in the set
                  ▼
  model sees: [ search_kb ]        ← everything else: GONE
                  │
          loop: call it ≤ 4 times, ≤ 6 turns, last turn no tools
                  ▼
  worst case a hijacked model can do: search again. That's it.
```

The kernel: **an explicit allowlist + a hard call budget.** Remove the allowlist
and the model sees every registered tool. Remove the budget and a confused or
hijacked model loops or fans out without limit. Both are load-bearing.

### Move 2 — the walkthrough

**The grant — an allowlist of exactly one.** This is the declaration, in aptkit:

```ts
// agents/rag-query/src/rag-query-agent.ts:15-18 (aptkit)
/** Least-privilege grant: this agent may only search the knowledge base. */
export const ragQueryToolPolicy: ToolPolicy = {
  capabilityId: RAG_QUERY_CAPABILITY_ID,
  allowedTools: [SEARCH_KNOWLEDGE_BASE_TOOL_NAME],   // ← one name, nothing else
};
```

The comment isn't decoration — it names the principle. `allowedTools` is the entire
authority surface. buffr registers only that one tool anyway (`src/session.ts:43-44`),
so the allowlist and the registry happen to match today — but the policy is what
*enforces* it. Add a write tool to the registry tomorrow and the model still can't
see it unless its name joins this array.

**The enforcement — a set intersection before any schema reaches the model.**

```ts
// tools/src/tool-policy.ts:11-23 (aptkit)
export function filterToolsForPolicy(allTools, policy): ModelTool[] {
  const allowed = new Set(policy.allowedTools);          // the allowlist as a Set
  return allTools
    .filter((tool) => allowed.has(tool.name))            // ← drop anything not allowed
    .map((tool) => ({ name: tool.name, description: ..., inputSchema: ... }));
}
```

Called at `agents/rag-query/src/rag-query-agent.ts:63-64` *before* the loop runs.
The model never even sees the schema of a disallowed tool, so it can't be coaxed
into calling one — there's nothing to call.

**The budget — turns and calls capped, tools stripped on the last turn.**

```ts
// agents/rag-query/src/rag-query-agent.ts:66-76 (aptkit)
await runAgentLoop({
  ...
  toolSchemas,          // the filtered one-tool list
  maxTurns: 6,          // ← at most 6 model round-trips
  maxToolCalls: 4,      // ← at most 4 tool invocations total
  synthesisInstruction: buildSynthesisInstruction('Now answer ... citing sources.'),
});
```

And the enforcement inside the loop:

```ts
// runtime/src/run-agent-loop.ts:101-106 (aptkit)
const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
const forceFinal = turn === maxTurns - 1 || budgetSpent;
const response = await model.complete({
  ...
  tools: forceFinal ? undefined : toolSchemas,   // ← last turn: NO tools at all
});
```

`forceFinal` does two things: once the budget is spent, or on the final turn, it
passes `tools: undefined` so the model *cannot* call anything, and it appends a
synthesis instruction forcing an answer. The loop can't run away.

**The handler — read-only.** The one reachable tool runs a SELECT:

```
  search_knowledge_base — what it actually does

  handler (retrieval/src/search-knowledge-base-tool.ts:78)
       │  pipeline.query(query, k)
       ▼
  PgVectorStore.search (src/pg-vector-store.ts:67)
       │  SELECT ... FROM agents.chunks ORDER BY embedding <=> $1
       ▼
  returns ranked chunks — NO insert, update, or delete in the path
```

There is no write tool, no shell tool, no HTTP tool anywhere in the registry. The
model's maximal authority is: read the knowledge base, up to four times.

### Move 2 variant — the load-bearing skeleton

The irreducible kernel is two parts:

1. **The allowlist** (`ragQueryToolPolicy.allowedTools`). Drop it and
   `filterToolsForPolicy` would pass every registered tool to the model — the moment
   a write or shell tool joins the registry, a prompt-injected document could reach
   it. This is what bounds *which* capabilities exist.
2. **The call budget** (`maxToolCalls: 4` / `maxTurns: 6` + `forceFinal`). Drop it
   and even a read-only tool can be driven in an unbounded loop — a denial-of-service
   against the local Ollama, or an attempt to enumerate the whole store. This bounds
   *how often* the capability fires.

Optional hardening layered on top: the `minTopK` floor (`src/session.ts:43`) and the
synthesis instruction are quality/robustness, not authority — strip them and the
agent is worse, not less safe.

### Move 3 — the principle

Least privilege is the cheapest insurance in security: you can't be hurt through a
capability you never granted. With agents it's doubly true, because the model is a
*confused-deputy* risk by construction — it follows instructions, including
instructions smuggled in through data. The defense isn't making the model
un-foolable; it's making the fooling harmless by ensuring the only lever it can pull
is read-only and finite. Scope the tools, bound the loop, and the worst case shrinks
to "it read something it didn't need to."

## Primary diagram

```
  Least-privilege tool scope — full picture

  ┌─ Service (src/session.ts) ───────────────────────────────┐
  │  registry = [ search_knowledge_base ]                     │
  └───────────────────────────────┬──────────────────────────┘
                                  │  agent.answer()
  ┌─ Agent (aptkit) ──────────────▼──────────────────────────┐
  │  ragQueryToolPolicy.allowedTools = [search_kb]           │
  │       │ filterToolsForPolicy (set intersection)          │
  │       ▼ model sees ONLY: search_kb                       │
  │  loop: maxTurns 6, maxToolCalls 4                        │
  │       last turn / budget spent → forceFinal: tools=undef │
  └───────────────────────────────┬──────────────────────────┘
                                  │  ≤ 4 calls, read-only
  ┌─ Storage ─────────────────────▼──────────────────────────┐
  │  pipeline.query → SELECT (no write path reachable)       │
  └───────────────────────────────────────────────────────────┘
  worst-case authority of a hijacked model: read, ≤4×. Done.
```

## Elaborate

This is the "confused deputy" problem named in 1988: a privileged component tricked
into misusing its authority on behalf of an attacker. An LLM agent is the modern
deputy — it'll faithfully act on text it can't tell is hostile. The industry answer
converged on exactly this shape: capability-scoped tool grants (allowlists), bounded
agent loops, and a hard separation between "tools the model can see" and "tools the
system has." aptkit bakes the allowlist into each agent capability (`*ToolPolicy`
constants) precisely so the grant is code, reviewable, not an implicit consequence
of what got registered.

The honest forward note: today the allowlist and the registry coincide (one tool
each), so the *filter* isn't yet doing visible work. Its value shows the moment buffr
adds a second, write-capable tool — at that point the policy is the line that keeps
it out of the RAG agent's reach. Building toward that is where this control earns its
keep.

## Interview defense

**Q: Your agent has one tool that you also only registered once. Why bother with a
policy filter at all?**
Because the registry is what *exists* and the policy is what *this capability may
reach* — two different questions. Today they coincide; the filter is insurance for
the day they don't. The moment a write tool joins the registry, `ragQueryToolPolicy`
is the single line that keeps a prompt-injected document from reaching it. Defense
that only matters after you add the dangerous thing is exactly the defense you want
in place *before* you add it.

```
  registry (exists)        policy (may reach)
  [ search, write ]   →    [ search ]
        write tool dropped here, by name, before the model sees it
```

**Q: What stops a hijacked agent from looping forever?**
`maxToolCalls: 4` and `maxTurns: 6`, plus `forceFinal` — the part people forget is
that the *last* turn passes `tools: undefined`, so the model physically can't call
anything and is forced to synthesize an answer. Bounded turns alone isn't enough;
you also have to remove the tools on the terminal turn or the model just asks for
more.

**Anchor:** "Scope the tools, bound the loop — a hijacked model can only read, and
only four times."

## See also

- `03-indirect-prompt-injection-surface.md` — the threat this scope contains.
- `audit.md` lens 7 — llm-and-agent-security, full walk.
- `.aipe/study-agent-architecture/` — the RagQueryAgent loop and tool registry.
