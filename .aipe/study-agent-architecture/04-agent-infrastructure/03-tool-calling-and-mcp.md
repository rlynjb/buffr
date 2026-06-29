# Tool Calling and MCP

*Industry names: **tool calling** / **function calling** (the capability); **MCP** (Model
Context Protocol) — the standardization layer. Type label: Industry standard. Tool calling
IMPLEMENTED in buffr (the emulated JSON path); MCP NOT YET.*

## Zoom out, then zoom in

Tool calling is the substrate under every agent pattern in this guide. ReAct's "Act," agentic
RAG's "search," routing's "pick a tool" — all of them are one mechanism: the model emits a
structured request to call a named function, and the harness runs it. This file is about how
buffr makes that work on a model with *no native tool support*, and the protocol (MCP) buffr
deliberately doesn't use.

```
  buffr's stack — tool calling is the substrate every pattern stands on

  ┌─ Agent loop (Sections A–C) ────────────────────────────────────┐
  │  ReAct · agentic RAG · routing — ALL reduce to "call a tool"   │
  └──────────────────────────┬─────────────────────────────────────┘
  ┌─ ★ TOOL CALLING — what the agent can TOUCH ★ ─────▼────────────┐
  │  InMemoryToolRegistry — listTools + callTool (records durationMs)│
  │  emulated JSON path — Gemma has no native tools array          │
  └──────────────────────────┬─────────────────────────────────────┘
  ┌─ The tool itself ─────────────────────────────────▼────────────┐
  │  search_knowledge_base → pgvector. (NO MCP — direct, in-process)│
  └─────────────────────────────────────────────────────────────────┘
```

The surprising part: buffr's model can't take a `tools` array at all. Gemma2 has no native tool
calling, so buffr *emulates* it — renders the tool schemas as JSON into the system text and
demands the model reply with JSON. The most load-bearing part: tool calling is just a
*request-response contract*, and once you see it as that, MCP is "what if that contract were a
network protocol instead of an in-process call."

## Structure pass

Two halves, one axis: **who speaks the contract** — the model side, then the harness side.

```
  Axis = WHO SPEAKS THE CONTRACT · trace the request-response round trip

  OUTBOUND (harness → model)   render tool schemas into system text     gemma-provider.ts:133-165
                               "respond with {"tool":...,"arguments":...}"
  ───────────────── ★ SEAM: the model replies with text ★ ─────────────────
  INBOUND (model → harness)    parse the model's JSON back to a tool_use  gemma-provider.ts:168-182
                               registry executes it, records durationMs   tool-registry.ts:50-64
```

The seam is the model's text reply. Everything before it is buffr *teaching* the model the tool
contract in plain prose; everything after is buffr *parsing* the model's attempt back into a
structured call. With a native-tool model, the provider does both halves for you. With Gemma,
buffr does them by hand — and that's the whole emulated JSON path.

## How it works

### Move 1 — mental model

A tool call is a typed request-response: the model says "run `search_knowledge_base` with
`{query: "x"}`," the harness runs it and hands back the result. Bridge from frontend: it is
exactly a `fetch()`. The model writes the request body (the tool name + args), the harness is the
server that executes it, and the result comes back to be rendered into the next prompt. The
registry is your API router — it maps a name to a handler.

```
  THE SHAPE — tool calling is a fetch() the model authors

  model authors the request ──▶ {"tool":"search_knowledge_base","arguments":{"query":"x"}}
                                          │
                              harness = the server  ─▶ registry.callTool(name, args)
                                          │                    │ runs handler → pgvector
                                          ▼                    ▼
                              result fed back into prompt ◀── {hits: [...]}, durationMs
```

### Outbound: render the tools as JSON into the system text

Gemma2 has no `tools` parameter, so buffr writes the tool catalog *into the prose* of the system
prompt and instructs the model on the exact reply format. Bridge from known: it's like documenting
an API endpoint inline and asking the caller to hand-write the request body, because there's no
typed client.

```ts
// @aptkit/providers/gemma — gemma-provider.ts:133-165 — OUTBOUND half of emulation.
function buildSystemText(request) {
  const parts = [];
  if (request.system) parts.push(request.system);          // profile + instructions go first
  if (request.tools?.length) {
    const rendered = request.tools.map((tool) =>
      JSON.stringify({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }, null, 2),
    ).join('\n\n');                                          // each tool schema → JSON text
    parts.push([
      'You can call the following tools:', '', rendered, '',
      'When a tool is needed, respond with ONLY a single JSON object, no prose:',
      '{"tool": "<tool name>", "arguments": { ...arguments... }}',   // ← the demanded contract
      'Otherwise, answer the user directly in natural language.',
    ].join('\n'));
  }
  return parts.join('\n\n');
}
```

```
  OUTBOUND — the tool schema becomes prose the model must obey

  ModelTool {name, description, inputSchema}
        │ JSON.stringify into system text
        ▼
  "You can call the following tools: { ...schema... }
   respond with ONLY {"tool":...,"arguments":...}"   ─▶ Gemma reads it as instructions
```

Annotation: this is why "strip the tools on the budget exit" (file 05, and
`02-agent-loop-skeleton.md`) works so cleanly — with no tools rendered into the system text,
there's simply no contract for the model to fulfill, so it can only answer in prose.

### Inbound: parse the model's JSON back into a tool call

The model replies with text. buffr parses it: if it's valid tool-call JSON, it becomes a
structured `tool_use` block; if it's prose, it's a real answer. And if it *looks* like a botched
attempt, buffr nudges once and retries. Bridge from known: it's `JSON.parse` on a response body,
with a retry on a malformed payload.

```ts
// gemma-provider.ts:168-182 — INBOUND half: messy text → {name, input} or null.
function parseToolCall(text) {
  let parsed;
  try { parsed = parseAgentJson(text); } catch { return null; }   // not JSON → prose, a real answer
  const obj = parsed;
  const name = obj.tool ?? obj.name ?? obj.tool_name;             // tolerate naming variants
  const input = obj.arguments ?? obj.input ?? obj.args;
  if (typeof name !== 'string') return null;
  if (!input || typeof input !== 'object') return null;
  return { name, input };                                         // → becomes a tool_use block
}
```

```ts
// gemma-provider.ts:35-37 — the retry nudge when the JSON is botched.
const RETRY_NUDGE =
  'Your previous reply was not a valid tool call. Respond with ONLY a single JSON object: ' +
  '{"tool": "<tool name>", "arguments": { ...arguments... }}';
// the loop only retries if the reply "looked like" a tool attempt (had a '{'); plain prose is a real answer.
```

```
  INBOUND — model text becomes a structured call, or a real answer

  model text ─▶ parseAgentJson
                  │
        ┌─────────┴──────────┐
        ▼                    ▼
   valid JSON?           not JSON / prose
   {tool,arguments}      → it's a REAL answer (success exit)
        │
        ▼  looked like a botched call? → RETRY_NUDGE once, then fall back to prose
   tool_use block ─▶ registry executes
```

Annotation: the asymmetry matters. Prose is never retried — only a reply that *looked* like a
failed tool call (it contained a `{`) gets the nudge. This keeps a genuine prose answer from being
mistaken for a malformed tool call.

### Execution: the registry maps name → handler and times it

Once buffr has a structured call, the registry runs it. `InMemoryToolRegistry` is a `Map` from
name to handler — your API router, in-process. It also records wall-clock duration for the
trajectory (which feeds file 04's evaluation story).

```ts
// @aptkit/tools — tool-registry.ts:33-64 — the registry: name → handler, timed.
export class InMemoryToolRegistry implements ToolRegistry {
  private readonly handlers = new Map();
  constructor(definitions, handlers) {                       // definitions = catalog, handlers = impls
    for (const [name, h] of Object.entries(handlers)) this.handlers.set(name, h);
  }
  listTools() { return this.definitions; }                   // what the model is told it can call
  async callTool(name, args, options) {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`tool not found: ${name}`);
    const start = performance.now();
    const result = await handler(args, options);
    return { result, durationMs: Math.round(performance.now() - start) };  // ← timing for traces
  }
}
```

```
  EXECUTION — the registry is the in-process API router

  listTools()  ─▶ catalog rendered into system text (outbound)
  callTool(name, args)
        │ Map.get(name) → handler
        ▼
   handler(args) → pgvector → result   +   durationMs (recorded for the trajectory)
```

Annotation: `listTools` and `callTool` are the two methods that define a tool registry anywhere —
one to advertise, one to execute. buffr's is in-memory and in-process. That's the no-MCP baseline.

### Move 3 — the principle, and where MCP fits

**Tool calling is a request-response contract; the only question is whether that contract is
in-process or over a wire.** buffr's contract is in-process: tools are defined directly,
registered in a `Map`, and called by a function call. There is **no MCP**. MCP (Model Context
Protocol) is the standardization layer that would turn buffr's in-process contract into a *network
protocol* — so any agent could connect to any tool server without bespoke wiring, and tools could
live in separate processes owned by separate teams. buffr doesn't have it, and that's a real
tradeoff to name, not hide.

```
  THE SPECTRUM — buffr's in-process registry vs MCP

  buffr TODAY (no MCP)                      MCP (NOT in buffr)
  ┌──────────────────────────┐             ┌──────────────────────────────┐
  │ tools defined in-process │             │ tools = separate MCP servers │
  │ InMemoryToolRegistry Map │             │ standard protocol over a wire│
  │ one process, one team    │             │ any agent ↔ any tool server  │
  │ + simplest, zero overhead│             │ + reusable, cross-team       │
  │ - bespoke, not shareable │             │ - protocol + transport cost  │
  └──────────────────────────┘             └──────────────────────────────┘
```

The tradeoff: buffr's in-process registry is the *simplest possible* tool wiring — zero protocol
overhead, one process, total control. The cost is that its one tool isn't reusable by another
agent without re-wiring. For a single agent with one read-only tool, in-process is correct. MCP
earns its keep when you have *many* agents sharing *many* tools across process and team
boundaries — which is the multi-agent shape buffr doesn't have yet.

## Primary diagram

Full recap: the emulated round trip, execution, and where MCP would slot in.

```
  buffr's tool calling — the emulated JSON path (gemma-provider.ts:133-182, tool-registry.ts:33-64)

  OUTBOUND  buildSystemText (:133-165): render tool schemas as JSON into system text
                │  "respond with {"tool":...,"arguments":...}"
                ▼
  MODEL     replies with text
                │
  INBOUND   parseToolCall (:168-182): JSON? → tool_use block. prose? → real answer.
                │  botched? RETRY_NUDGE once (:35-37)
                ▼
  EXECUTE   InMemoryToolRegistry.callTool (:50-64): Map name→handler, run, record durationMs
                │
                ▼  result fed back into messages → next turn
  ── MCP (NOT YET) would replace the in-process registry with a wire protocol ──
```

Two halves to emulate the contract, one registry to run it, no MCP. That's tool calling in buffr.

## Elaborate

The emulated JSON path is a workaround for a model limitation, but it exposes the *real* shape of
tool calling more honestly than a native-tool model does. A native model hides the contract inside
the provider; Gemma forces buffr to write the contract in plain text, which makes it obvious that
tool calling is "ask the model to produce a structured string, then parse it." The retry nudge
(`:35-37`) and the `looksLikeToolAttempt` check are the reliability tax of emulation — a native
model would not need them, but they cost almost nothing and make a 9B model usably reliable at
emitting JSON.

The multi-agent shape of tool calling is precisely MCP: a fleet of agents needs a *standard* way to
discover and call tools they didn't define, owned by other teams, possibly on other machines. MCP
is the protocol that makes a tool a network service instead of a function call. buffr is
single-agent with one in-process tool, so it correctly skips the protocol. Name MCP as the thing
you'd reach for the moment a *second* agent needs to share buffr's `search_knowledge_base` — not
before.

Cross-ref `study-ai-engineering` for tool-calling mechanics (schema design, argument validation,
parallel tool calls) — this file covers only the substrate-and-protocol angle and buffr's emulated
path.

## Interview defense

**Q: "Your model has no native tool calling. How do tools work? And why no MCP?"**

Model answer: "I emulate the tool contract in two halves. Outbound, `buildSystemText`
(`gemma-provider.ts:133-165`) renders each tool's schema as JSON into the system text and demands
the model reply with `{"tool":...,"arguments":...}`. Inbound, `parseToolCall` (`:168-182`) parses
the reply: valid JSON becomes a structured tool-use block, prose is treated as a real answer, and a
botched attempt gets one retry nudge (`:35-37`). Execution is `InMemoryToolRegistry.callTool`
(`tool-registry.ts:50-64`) — a `Map` from name to handler that also records `durationMs` for the
trajectory. There's no MCP: tools are defined in-process. That's the right call for a single agent
with one read-only tool — MCP is a wire protocol that earns its keep when many agents share many
tools across process and team boundaries, which I don't have yet. I'd adopt MCP the moment a second
agent needed to call my `search_knowledge_base`."

```
  The defense in one picture

  no native tools  →  EMULATE: render schemas as JSON (out) + parse JSON (in)
  no MCP           →  in-process registry (Map name→handler); correct for 1 agent, 1 tool
                      MCP = the wire protocol you adopt when a 2nd agent needs the tool
```

Anchor: *Tool calling is a request-response contract — emulated in JSON for Gemma
(`gemma-provider.ts:133-182`), executed by an in-process registry (`tool-registry.ts:33-64`); no
MCP, because one agent with one tool doesn't need a wire protocol.*

## See also

- `../01-reasoning-patterns/02-agent-loop-skeleton.md` — the loop that calls the registry;
  stripping the tools on the budget exit relies on the outbound emulation here.
- `../02-agentic-retrieval/01-agentic-rag.md` — the one tool buffr wires is retrieval.
- `05-guardrails-and-control.md` — capability scoping filters which tools the registry exposes.
- `04-agent-evaluation.md` — `durationMs` recorded by `callTool` feeds the trajectory.
- `study-ai-engineering` → tool-calling mechanics (schema design, argument validation).
