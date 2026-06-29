# Tool calling and MCP — emulated tools under every pattern

**Industry name(s):** tool calling · function calling · emulated tool
use · MCP (Model Context Protocol). **Type label:** Industry standard.

**In this codebase: yes — and notably, tool-calling is EMULATED.**
Gemma2:9b has no native tool API, so aptkit renders the tool schema into
the system prompt and parses a JSON tool call back out. buffr does not
use MCP — its one tool is wired in-process via `InMemoryToolRegistry`.

## Zoom out, then zoom in

```
  Zoom out — tool calling is the substrate under every pattern

  ┌─ ReAct / agentic RAG / every topology ───────────────────┐
  │  all run on: model emits intent → harness runs tool       │
  │                       ▼                                   │
  │  ★ tool calling (emulated for Gemma) ★                    │ ← we are here
  └───────────────────────────┬──────────────────────────────┘
                              │  JSON tool call ↔ result
  ┌─ Tool layer ──────────────▼──────────────────────────────┐
  │  InMemoryToolRegistry → search_knowledge_base handler     │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: tool calling is the connective tissue ReAct, agentic RAG, and
every multi-agent topology run on. The buffr-specific twist is that the
model can't call tools natively — the calling is *emulated* in the
prompt. MCP is the protocol that would standardize tool connections
across agents; buffr doesn't need it yet with one in-process tool.

## Structure pass

**Layers.** Three: the model (emits a tool call), the provider
(emulates the calling for Gemma), and the registry (runs the handler).

**Axis — "how does the tool call cross from model to code?"** With a
native-tool model, the provider API carries it. With Gemma, the *prompt*
carries it out and a *JSON parser* carries it back. That emulation is
the buffr-specific mechanism.

**Seam.** Two seams: the prompt→model boundary (where tools are rendered
into the system text) and the model→harness boundary (where JSON is
parsed back into a tool call). Both live in `GemmaModelProvider`.

## How it works

#### Move 1 — the mental model

A native-tool model is like an API with typed endpoints — you hand it a
tool schema and it calls it. Gemma is like an API that only speaks plain
text, so you *describe* the endpoints in the request and *parse* the
response to figure out which one it meant. That's emulation: tools by
convention, not by protocol.

```
  Pattern — emulated tool calling (Gemma)

  OUTBOUND:  render tool schema INTO the system prompt
             "respond with ONLY {"tool": "...", "arguments": {...}}"
                   │
                   ▼
  MODEL:     emits JSON text (no native tool_use block)
                   │
  INBOUND:   parse the JSON back into { name, input }
                   │ retry once with a nudge if malformed
                   ▼
             harness runs the tool
```

#### Move 2 — the walkthrough

**Outbound: tools rendered into the system text.** `GemmaModelProvider`
can't take a native `tools` array, so `buildSystemText` serializes each
tool's schema into the prompt (`gemma-provider.js:82-104`):

```js
parts.push([
  'You can call the following tools:', '',
  rendered,  // JSON.stringify of {name, description, input_schema}
  '',
  'When a tool is needed, respond with ONLY a single JSON object, no prose:',
  '{"tool": "<tool name>", "arguments": { ...arguments... }}',
  'Otherwise, answer the user directly in natural language.',
].join('\n'));
```

So the tool "API" is literally instructions in the prompt. This is why
the system prompt's "always call search_knowledge_base first" matters so
much — it's the only thing making Gemma use the tool.

**Inbound: parse the JSON back, retry once if botched.** After Gemma
responds, the provider tries to parse a tool call out of the raw text
(`gemma-provider.js:33-41, 107-125`). If it's valid JSON with a `tool`
and `arguments`, it's converted into a synthetic `tool_use` block — the
same shape a native-tool model would emit, so `runAgentLoop` is none the
wiser. If the text *looks* like a botched tool attempt (contains a `{`)
but doesn't parse, it retries once with a corrective nudge
(`RETRY_NUDGE`, `gemma-provider.js:2-3, 25`). Plain prose is treated as
a real answer, not a failed tool call.

**The registry runs the handler, the model never does.** The parsed
tool call goes to `InMemoryToolRegistry.callTool`
(`tool-registry.js:14-24`), which looks up the handler and times it. The
model emitted *intent*; the registry executed it. That boundary is the
safety story from `02-agent-loop-skeleton.md`, made concrete: even an
emulated tool call is data the harness interprets, never code the model
runs.

**No MCP — one in-process tool.** buffr wires its single tool directly
into the registry (`src/session.ts:43-44`). MCP exists to standardize
tool connections *across* agents and processes so a tool defined once is
usable everywhere without per-agent integration. With one tool in one
process, MCP would be pure overhead. The day buffr's two-brain design
needs the phone and laptop to share tools, MCP (or a tool gateway) is
what would standardize that — a future concern, not a current one.

```
  Layers-and-hops — an emulated tool call, end to end

  ┌─ Gemma ──────┐ hop 1: JSON text     ┌─ GemmaProvider ──────┐
  │ emits        │ ───────────────────► │ parseToolCall        │
  │ {"tool":...} │                      │ → synthetic tool_use │
  └──────────────┘                      └──────────┬───────────┘
                                          hop 2     │ {name, input}
                                                    ▼
                                         ┌─ InMemoryToolRegistry ─┐
                                         │ callTool → handler     │
                                         │ → retrieval pipeline   │
                                         └────────────────────────┘
```

#### Move 3 — the principle

Tool calling is the substrate every agent pattern runs on, and it
doesn't require a native tool API — it can be emulated by rendering
schemas into the prompt and parsing JSON back out. The cost of emulation
is fragility (a weak model botches the JSON, hence the retry-with-nudge)
and prompt-token overhead (the schema lives in every system prompt). The
benefit is that a stock local model with zero tool training becomes an
agent. MCP standardizes this *across* agents; with one in-process tool,
buffr rightly skips it.

## Primary diagram

```
  buffr's emulated tool calling (gemma-provider.js)

  system prompt: base + RENDERED tool schema + "respond ONLY JSON"
        │
        ▼
  Gemma emits JSON text ──► parseToolCall ──► synthetic tool_use block
        │ (retry once with nudge if malformed)        │
        │ plain prose? → treat as final answer        ▼
        ▼                                    InMemoryToolRegistry.callTool
   runAgentLoop (unaware it was emulated)    → search_knowledge_base handler
```

## Elaborate

Emulated tool calling is what makes aptkit model-agnostic: the
`runAgentLoop` works with a native-tool provider or an emulated one
because the provider normalizes both to the same `tool_use` shape. The
emulation's fragility is real — the `maxToolCallAttempts: 2` retry
(`gemma-provider.js:13`) exists precisely because Gemma sometimes wraps
its JSON in prose. MCP is the next layer up: a protocol so tools defined
once are reusable across agents and processes — relevant only when buffr
goes multi-process (the two-brain design). The tool-calling *mechanics*
(schema design, validation) would be detailed in a future
`study-ai-engineering` tool-calling file.

## Interview defense

**Q: How does buffr call tools if Gemma has no native tool API?**
It emulates them. The provider renders each tool's schema into the
system prompt and instructs Gemma to "respond with ONLY a JSON object"
(`gemma-provider.js:82-104`), then parses that JSON back into a
synthetic `tool_use` block so the loop is provider-agnostic. If Gemma
botches the JSON, it retries once with a corrective nudge. Plain prose is
treated as a real answer.

```
  render schema → prompt | Gemma emits JSON | parse → tool_use (retry once)
```

**Anchor:** "Tool calling is emulated in the prompt — a stock model with
no tool training becomes an agent, at the cost of JSON fragility."

**Q: Why no MCP?**
One in-process tool. MCP standardizes tool connections across agents and
processes; with a single tool wired directly into the registry, it'd be
pure overhead. It becomes relevant if the two-brain design needs the
phone and laptop to share tools.

## See also

- `02-agent-loop-skeleton.md` — the execute step this implements
- `01-reasoning-patterns/03-react.md` — the pattern this substrate runs
- `05-agent-infrastructure → 05-guardrails-and-control.md` — the
  model-emits-intent safety boundary
- `.aipe/study-security/04-least-privilege-tool-scope.md` — the
  single-tool scope from the security angle
