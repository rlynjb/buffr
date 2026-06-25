# Least-Privilege Tool Scope

*Tool allowlisting / capability scoping + bounded agent loop — Industry standard (agent security).*

## Zoom out, then zoom in

The agent could be handed many tools. It's handed exactly one, behind an
allowlist, behind a hard call budget. That's the control that keeps the
prompt-injection surface (`03-`) boring.

```
  Zoom out — what the agent is ALLOWED to do

  ┌─ CLI ────────────────────────────────────────────────────────┐
  │  registers tools: [ search_knowledge_base ]                   │
  └─────────────────────────┬────────────────────────────────────┘
                            │  RagQueryAgent(model, tools, ...)
  ┌─ Agent ────────────────▼─────────────────────────────────────┐
  │  policy: allowedTools = [search_knowledge_base]  ← ★ allowlist │
  │  filterToolsForPolicy strips the model's menu to the allowed   │
  │  budget: maxTurns 6, maxToolCalls 4              ← ★ hard cap   │
  └─────────────────────────┬────────────────────────────────────┘
                            │  model may call only what survived the filter
  ┌─ Tool ─────────────────▼─────────────────────────────────────┐
  │  search_knowledge_base — READ ONLY (vector search)            │
  │  no write tool · no shell · no fetch                          │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: least privilege is the oldest security principle there is — *give a
component exactly the access its job needs, no more.* For an agent that
means: the model proposes tool calls, but it can only actually invoke tools
on an allowlist, and only a bounded number of times. The question this file
answers: *if the model is fully compromised by an injected instruction, what
can it actually do?* The answer here is "run a read-only search up to four
times, then it's forced to answer." That's a small blast radius, and it's by
design.

## Structure pass

**Layers.** Two: *what the model wants* (it can propose any tool call in its
output) and *what the runtime permits* (only allowlisted tools, only within
budget). Control flips between them.

**Axis — control.** Trace "who decides whether a tool runs?" down the layers:

```
  One axis (control) across the agent's tool layer

  ┌─ model layer ─────────────────┐
  │  proposes tool calls freely    │  → MODEL decides what to ask for
  └────────────────────────────────┘     (could ask for anything)
  ┌─ policy filter ───────────────┐
  │  filterToolsForPolicy          │  → CODE decides what's offered
  └────────────────────────────────┘     (allowlist — model never sees the rest)
  ┌─ budget guard ────────────────┐
  │  maxToolCalls / maxTurns       │  → CODE decides when to stop
  └────────────────────────────────┘     (forced synthesis when spent)

  control flips from model to code at the policy seam — that flip
  is the whole security property
```

**Seam.** The load-bearing seam is `filterToolsForPolicy` — the boundary
where the model's *desire* meets the runtime's *permission*. On the model
side, free choice; on the code side, an allowlist the model can't expand.
This is the same seam shape as `02-`'s "advisory vs enforced," but here the
enforcement *is* present: the model can't call a tool that isn't in the
filtered schema list, because it never even sees it.

## How it works

### Move 1 — the mental model

You know how a React component only gets the props you pass it — it can't
reach up and grab state you didn't hand down. Tool scoping is that, for an
agent: the model only gets the tools the policy hands it. It can *ask* for a
`delete_everything` tool in its output, but if that tool isn't in the
filtered list, the runtime has nothing to dispatch to — the request is a
no-op. Capability comes from what you pass down, not what the model requests.

```
  The shape — the model's menu is filtered before it ever chooses

  all registered tools         policy allowlist        model's actual menu
  ┌──────────────────┐         ┌──────────────┐        ┌──────────────────┐
  │ search_kb         │         │ search_kb    │   →    │ search_kb        │
  │ (none others here)│   ∩     │ (only this)  │        │ (only this)      │
  └──────────────────┘         └──────────────┘        └──────────────────┘
                                                              │
       the model literally cannot name a tool outside this ──┘
       set, because the set IS its tool schema for the run
```

One sentence: **the model chooses freely, but only from a menu code already
filtered — and a bounded number of times.**

### Move 2 — the walkthrough (load-bearing skeleton)

The kernel of this control has three parts. Remove any one and the blast
radius grows.

**Part 1 — the allowlist policy.** `ragQueryToolPolicy` names exactly the
tools this capability may use: `[search_knowledge_base]`
(`rag-query-agent.js:7-11`). It's a deny-by-default list — anything not named
is excluded. What breaks if removed: the model could invoke *any* registered
tool. With only search registered today that's moot, but the policy is what
makes adding a dangerous tool to the registry *not* automatically expose it
to this agent.

**Part 2 — the filter that enforces it.** `filterToolsForPolicy`
(`tool-policy.js:2-10`) intersects the registered tools with the allowlist
and returns only the survivors as the model's tool schema
(`rag-query-agent.js:36-37`). What breaks if removed: the policy becomes a
comment — declared but unenforced, the `02-` failure mode. The filter is the
step that turns the allowlist from advisory into enforced; the model's tool
schema for the run literally *is* the filtered set.

```
  Allowlist + filter = enforced (not advisory) scope

  policy.allowedTools = ['search_knowledge_base']     ← the declaration
        │
        ▼ filterToolsForPolicy(allTools, policy)
  toolSchemas = [ search_knowledge_base ]             ← what the model receives
        │
        ▼ passed to runAgentLoop as `tools: toolSchemas`
  the model's tool-calling menu is EXACTLY this — it can't name anything else
```

**Part 3 — the bounded loop.** Hard caps stop the agent from looping
forever, whether from a confused model or an injection-induced spin:
`maxTurns: 6`, `maxToolCalls: 4` (`rag-query-agent.js:48-49`), enforced in
`run-agent-loop.js:25-28`. When the budget is spent, the loop sets
`forceFinal` and drops the tools from the next call entirely
(`:28,32`), forcing a synthesis turn (`buildSynthesisInstruction`, `:17-19`).
What breaks if removed: an unbounded loop — the agent re-searches forever,
burning the operator's Ollama compute and never answering. The cap is the
part people forget; it's the agent-loop equivalent of a rate limiter's window
reset.

```
  The loop budget — control flips to code when the budget is spent

  turn 0  ─► model: tool call (search)   toolCalls=1   budget ok
  turn 1  ─► model: tool call (search)   toolCalls=2   budget ok
  ...
  turn N  ─► toolCalls >= maxToolCalls(4) ──► forceFinal = true
              │
              ▼ model.complete called with tools: undefined  (:32)
              + synthesisInstruction appended  (:30)
              "You have NO more tool calls. Answer now."
              │
              ▼ model MUST produce a final answer — no more actions
```

**Skeleton vs hardening.** The allowlist + filter + budget are the skeleton —
strip any one and the blast radius or the loop bound is gone. The 16K-char
tool-output truncation (`run-agent-loop.js:2-7`) and the tool's
hallucinated-filter no-op (`search-knowledge-base-tool.js:48-53`) are
*hardening* layered on top — nice limiters, but the security property holds
without them.

### Move 3 — the principle

The principle: **scope an agent to the minimum capability its task needs, and
enforce the scope in code the model can't reach.** The model is a powerful but
fundamentally untrusted planner — treat its proposed actions like user input,
because (via `03-`) they can *be* attacker input. Least privilege turns "the
model got tricked" from a breach into a non-event: a tricked model that can
only call one read-only tool, four times, can't do anything worth worrying
about. The security isn't in trusting the model; it's in bounding it.

## Primary diagram

The full picture: free model proposal, code-enforced allowlist, hard budget,
read-only floor.

```
  buffr-laptop — least-privilege tool scope, end to end

  ┌─ Model (untrusted planner) ─────────────────────────────────┐
  │  proposes: search_kb · (or anything it hallucinates)        │
  └─────────────────────────┬───────────────────────────────────┘
                            │  but its menu was pre-filtered:
  ┌─ Policy + filter (code-enforced) ──────────────────────────┐
  │  allowedTools = [search_knowledge_base]                     │
  │  filterToolsForPolicy → model only ever sees this one tool  │
  └─────────────────────────┬───────────────────────────────────┘
                            │  + budget guard
  ┌─ Bounded loop (run-agent-loop) ────────────────────────────┐
  │  maxToolCalls 4 / maxTurns 6 → forceFinal → synthesis turn  │
  └─────────────────────────┬───────────────────────────────────┘
                            │  dispatches only allowed, in-budget calls
  ┌─ Tool floor ───────────▼───────────────────────────────────┐
  │  search_knowledge_base — READ ONLY                          │
  │  no write · no shell · no fetch · no exfil path             │
  └──────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Reached on every `npm run chat` turn. The agent is built once
per session (`session.ts:34-57`) with a one-tool registry and runs under the
policy + budget on every question. There's no code path where the agent gets
a broader tool set — the scope is uniform, even now that conversation memory
adds a second *retrievable source* (it does not add a tool: memory surfaces
through the same `search_knowledge_base`, so the allowlist is unchanged).

**Code side by side.**

```
  src/session.ts  (lines 43–44)

  const tool = createSearchKnowledgeBaseTool(pipeline, { minTopK: 4 });
  const tools = new InMemoryToolRegistry([tool.definition], {...});
        │
        └─ only ONE tool is ever registered. Even before the policy filter,
           the registry holds a single read-only search tool. The blast-radius
           floor starts here. createConversationMemory (:53) adds NO tool —
           it reuses this same search path to recall past turns.
```

```
  @aptkit/agent-rag-query rag-query-agent.js  (lines 7–11, 36–37, 48–49)

  export const ragQueryToolPolicy = {
    capabilityId: RAG_QUERY_CAPABILITY_ID,
    allowedTools: [SEARCH_KNOWLEDGE_BASE_TOOL_NAME],   ← deny-by-default allowlist
  };
  ...
  const allTools = await this.options.tools.listTools();
  const toolSchemas = filterToolsForPolicy(allTools, ragQueryToolPolicy);  ← enforce
  ...
  maxTurns: 6, maxToolCalls: 4,                        ← hard budget
        │
        └─ the policy is declared (7–11), enforced via the filter (37), and
           the loop is bounded (48–49). All three together are the control.
```

```
  @aptkit/tools tool-policy.js  (lines 2–10) — the enforcement seam

  export function filterToolsForPolicy(allTools, policy) {
    const allowed = new Set(policy.allowedTools);
    return allTools
      .filter((tool) => allowed.has(tool.name))   ← intersect with allowlist
      .map((tool) => ({ name: tool.name, ... }));  ← only survivors become schema
  }
        │
        └─ this is where "the model may only call X" stops being advisory.
           The returned list IS the model's tool menu for the run. A tool not
           in `allowed` is never offered, so the model can't name it.
```

```
  @aptkit/runtime run-agent-loop.js  (lines 25–32) — the budget guard

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
    const forceFinal = turn === maxTurns - 1 || budgetSpent;   ← stop condition
    const response = await model.complete({
      system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
      tools: forceFinal ? undefined : toolSchemas,             ← tools removed when spent
      ...
    });
        │
        └─ when the budget is spent, tools are withheld (forceFinal → undefined)
           and the model is told to answer now. This is what makes the loop
           terminate even under an injection that keeps requesting searches.
```

## Elaborate

Least privilege for agents is the direct application of a 1970s OS principle
(Saltzer & Schroeder) to a 2020s problem. The shift that makes it urgent: an
agent's "user" is a non-deterministic model whose instructions can be
attacker-controlled (`03-`). So you treat the model exactly as you'd treat an
untrusted client — give it the narrowest capability set, enforce it server-
side (here, in the runtime, not in the prompt), and bound its resource use.

The pairing with `03-` is the whole story. You can't prevent a hostile chunk
from misleading the model — that's inherent to retrieval. What you *can* do is
guarantee that a misled model is harmless, and you do it by making its only
capability a read-only search behind an allowlist behind a budget. This is
the difference between a security property that depends on the model behaving
(fragile) and one that holds even when the model misbehaves (robust). The
robust one is the one to build, and this repo built it: the security lives in
the runtime's policy filter and loop bound, where the model can't touch it —
not in the system prompt, where an injection could.

## Interview defense

**Q: Your agent uses an LLM you've established can be prompt-injected. Why
isn't that a critical vulnerability?**

Because a successfully injected model can only do what its tools let it, and
its tools are one read-only search, capped at four calls. The control is
three parts:

```
  what stops a compromised model from doing damage

  allowlist   →  only search_knowledge_base permitted (deny-by-default)
  filter      →  enforced in code — the model's menu IS the filtered set
  budget      →  maxToolCalls 4 → forced answer, loop can't spin
```

The anchor: **I design for the injection succeeding and bound the
consequences.** Even fully compromised, the worst the model does is run a
read-only search a few times on my laptop — no write, no shell, no network
egress, no exfiltration path. The security isn't "the model won't get
tricked"; it's "a tricked model is harmless."

**Q: What's the one part of this people forget?**

The loop budget. Everyone gets the allowlist; the part that's easy to skip is
the hard `maxToolCalls`/`maxTurns` cap with a forced synthesis turn
(`rag-query-agent.js:48-49`, enforced at `run-agent-loop.js:25-32`). Without
it, an injection that keeps saying "search again" spins the agent forever,
burning compute and never answering. The cap is the agent-loop equivalent of
a rate limiter's window reset — name it and it signals you've actually run an
agent loop in anger, not just read about ReAct.

## Validate

1. **Reconstruct.** Name the three skeleton parts (allowlist / filter /
   budget) and, for each, what specifically an attacker gains if it's
   removed.
2. **Explain.** Why does enforcing the scope in `filterToolsForPolicy`
   (code) rather than in the system prompt matter, given `03-`?
3. **Apply.** A teammate wants to add a `write_note` tool so the agent can
   save findings. Walk the exact changes to the policy and the blast-radius
   analysis, and say what new mitigation you'd require.
4. **Defend.** Argue why shipping an agent over potentially-injectable
   retrieved content is acceptable *here* — tie it to the specific tool floor
   and budget, not a general "it's probably fine."

## See also

- `03-indirect-prompt-injection-surface.md` — the partner. This file is *why*
  that surface has low blast radius. Read them together: one is the surface,
  one is the containment.
- `02-shape-only-tenant-isolation.md` — the contrast on enforcement. There,
  the scope is advisory (no RLS); here, the tool scope is genuinely enforced
  in code. Same "advisory vs enforced" axis, opposite verdict.
- `study-agent-architecture` — the ReAct loop, the tool registry, the
  capability-policy model these controls live inside.

Updated: 2026-06-24 — purged `ask-cmd.ts` ref → `session.ts:43-44`; noted conversation memory adds a retrievable source, not a tool — the one-tool allowlist (and the blast radius) is unchanged.
