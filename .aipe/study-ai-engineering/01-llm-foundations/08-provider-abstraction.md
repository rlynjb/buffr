# Provider Abstraction

*Provider interface / adapter + factory — the swap seam — Industry standard.*

## Zoom out, then zoom in

buffr talks to two very different AI services — Ollama for embeddings, Ollama for generation — through two clean interfaces, never directly. Swap the model, swap the embedder, wrap one in a guard: the agent above never notices. This is the load-bearing seam of the whole foundations section. Here's where the interfaces sit, and the one box where the hardest emulation hides.

```
  Zoom out — where provider abstraction lives in buffr

  ┌─ Agent layer (aptkit) ──────────────────────────────────────────┐
  │  RagQueryAgent / runAgentLoop  — codes against INTERFACES only   │
  │     model: ModelProvider        store: VectorStore               │
  │     embedder: EmbeddingProvider                                  │
  └──────────────────────────┬───────────────────────────────────────┘
                             │  interface calls (never concrete types)
  ┌─ Provider layer ─────────▼───────────────────────────────────────┐
  │  ContextWindowGuardedProvider ──wraps──► ★ GemmaModelProvider ★  │ ← tool-call EMULATION
  │  OllamaEmbeddingProvider (embeddings)                           │   lives here
  │  PgVectorStore (buffr's own VectorStore impl)                   │
  └──────────────────────────┬───────────────────────────────────────┘
                             │  HTTP / SQL
  ┌─ External services ──────▼───────────────────────────────────────┐
  │  Ollama (gemma2:9b, nomic-embed-text:v1.5)   ·   Postgres+pgvector│
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in: a provider abstraction is an *interface* (the contract: "anything that can `complete(request)` is a model") plus *concrete adapters* behind it (`GemmaModelProvider` is one such thing) plus a *factory* that wires the chosen adapter in (buffr's `session.ts`). The payoff: the agent loop is written once against `ModelProvider`, and you can wrap, swap, or mock the implementation freely. The twist that makes this file load-bearing for buffr: `gemma2:9b` has **no native tool-calling**, so `GemmaModelProvider` *emulates* it — and the emulation is a pure provider concern, invisible above the seam. That's the deepest idea in the section.

## Structure pass

Trace the axis **does the layer above know which concrete provider it's talking to?** down the stack.

```
  Axis: "does the caller know the concrete type?" — across the interface seam

  ┌─ Agent loop (runAgentLoop) ──────────────┐
  │  sees: ModelProvider, EmbeddingProvider  │  knows concrete? NO — interfaces only
  └─────────────────────┬─────────────────────┘
                        │  seam: the interface contract (.complete / .embed)
  ┌─ Concrete adapters ─▼─────────────────────┐
  │  GemmaModelProvider, OllamaEmbeddingProv. │  knows concrete? YES — it IS the concrete
  │  (Gemma emulates tools HERE, hidden above)│
  └─────────────────────┬─────────────────────┘
                        │  seam: HTTP/SQL transport
  ┌─ External service ──▼─────────────────────┐
  │  Ollama / Postgres                        │  knows concrete? it's the wire protocol
  └───────────────────────────────────────────┘
```

The load-bearing seam is the **interface contract** between the agent and the adapters. Above it, code is generic; below it, code is specific. Everything hard and provider-specific — tool emulation, token mapping, the embedding dimension, the context guard — lives *below* the seam, so the agent stays clean. The whole value of the pattern is that the axis answer flips at exactly one boundary: "I don't know what you are, only what you promise" above, "I am specifically Gemma-over-Ollama, here's how I fake tools" below.

## How it works

#### Move 1 — the mental model

You know how a React component takes an `onClick` prop and doesn't care whether it logs, navigates, or fires an API call — it just calls the contract? A provider interface is that, for an external AI service: the agent calls `model.complete(request)` and doesn't care that, underneath, Gemma is faking tool support with prompt text. The strategy: **program to an interface; hide the provider-specific mess inside the adapter; wire the choice in a factory.** And a second strategy stacked on top: **decorate** — wrap one provider in another that adds a behavior (the guard) without changing the interface.

```
  Pattern — interface + adapter + decorator + factory

  ┌─ interface ─┐   contract every model must satisfy
  │ ModelProvider│   complete(request) → response
  └──────┬───────┘
         │ implemented by
  ┌──────▼────────────┐    wrapped by (same interface!)
  │ GemmaModelProvider │◄──┐  ┌─ ContextWindowGuardedProvider ─┐
  │  (the adapter)     │   └──│  pre-checks size, then delegates│  ← decorator
  └────────────────────┘      └─────────────────────────────────┘
         ▲ chosen + assembled by
  ┌──────┴───────────────────────────────────┐
  │ session.ts (the factory) — wires it all   │
  └────────────────────────────────────────────┘
```

#### Move 2 — the step-by-step walkthrough

**The interface the agent codes against.** The agent never imports `GemmaModelProvider`; it accepts a `ModelProvider`. Same for embeddings (`EmbeddingProvider`) and storage (`VectorStore`).

```
  RagQueryAgentOptions — rag-query-agent.ts:33-43 (annotated)

  export type RagQueryAgentOptions = {
    model: ModelProvider;   // ← the CONTRACT, not GemmaModelProvider
    tools: ToolRegistry;
    profile?: string;
    ...
  };
```

`model: ModelProvider`. The agent's entire knowledge of the model is "it has `.complete`." This is the seam: everything below can change as long as that promise holds.

**The factory that wires concrete adapters in.** buffr's `session.ts` is the composition root — the one place that names concrete types and assembles them.

```
  createChatSession — src/session.ts:40-46,57 (annotated)

  const embedder = new OllamaEmbeddingProvider({ model: 'nomic-embed-text:v1.5', host });  // :40
  const store    = new PgVectorStore({ pool, appId, dimension: embedder.dimension });       // :41
  ...
  const model = new ContextWindowGuardedProvider(          // :46  ← decorator
                  new GemmaModelProvider({ host }),        //       ← concrete adapter
                  { maxTokens: 8192 });
  ...
  const agent = new RagQueryAgent({ model, tools, profile, trace });  // :57 ← inject interfaces
```

Concrete types appear *only here*. The agent at `:57` receives the assembled `model` as a `ModelProvider` and is none the wiser. Swap `GemmaModelProvider` for an `OpenAIModelProvider` and only this file changes — the agent, the loop, the tool, all untouched. That's the swap seam earning its keep.

**The decorator: same interface, added behavior.** `ContextWindowGuardedProvider` *is a* `ModelProvider` that *wraps a* `ModelProvider`. It pre-checks size, then delegates.

```
  ContextWindowGuardedProvider.complete — context-window-guard.ts:57-70 (annotated)

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const estimate = estimateContextWindow(request, this.options);   // size check (len/3)
    if (!estimate.ok) {
      this.options.trace?.emit({ type: 'warning', ... });            // observe the refusal
      throw new ContextWindowExceededError(estimate);                // refuse BEFORE delegating
    }
    return this.provider.complete(request);   // ← delegate to the wrapped GemmaModelProvider
  }
```

It adds a guard without changing the contract, so it nests transparently. The agent calls `.complete`; it doesn't know (or need to know) that a size-check happens first. This is the same idea as wrapping a `fetch` in a retry-or-validate wrapper that still looks like `fetch`.

**The hard part — Gemma EMULATES tool-calling, entirely below the seam.** This is the deepest reason provider abstraction matters in buffr. `gemma2:9b` has no native `tools` parameter. So `GemmaModelProvider` fakes the whole protocol: render the tool schemas into the prompt as text, then parse a JSON object back out. The agent thinks it's doing structured tool-calling; underneath, it's string-in-string-out.

```
  Layers-and-hops — tool-call emulation, hidden inside the provider

  ┌─ Agent loop ─┐  request.tools = [search_knowledge_base schema]   ┌─ GemmaModelProvider ─┐
  │ runAgentLoop │ ──── "native" tool-calling contract ──────────────►│  complete()          │
  └──────┬───────┘                                                    └─────────┬─────────────┘
         │                                              hop A: buildSystemText  │
         │                                              schema → PROMPT TEXT    ▼
         │                                        ┌─ Ollama gemma2:9b (no tools API) ─┐
         │                                        │  reads schema as plain text       │
         │                                        │  emits {"tool":...,"arguments":..} │
         │                                        └─────────────────┬──────────────────┘
         │  hop C: tool_use block ◄── parseToolCall  ───────────────┘
         ▼                              (parse JSON back, input AS-IS)
  agent dispatches the tool — never knowing it was all emulated
```

**Emulation, outbound half — `buildSystemText`.** The schemas get JSON-serialized into the system prompt with an instruction to reply with one JSON object.

```
  buildSystemText — gemma-provider.ts:137-161 (annotated)

  const rendered = request.tools.map((tool) =>
    JSON.stringify({ name: tool.name, ..., input_schema: tool.inputSchema }, null, 2)  // schema → text
  ).join('\n\n');
  parts.push([
    'You can call the following tools:', '', rendered, '',
    'When a tool is needed, respond with ONLY a single JSON object, no prose:',
    '{"tool": "<tool name>", "arguments": { ...arguments... }}',
  ].join('\n'));
```

There is no `tools` array on the wire — there's a system prompt that *describes* tools. That's the emulation outbound.

**Emulation, inbound half — `parseToolCall`, and the reliability ceiling.** The model's text is parsed back into `{name, input}`, with the input passed **as-is** — no validation against the schema.

```
  parseToolCall — gemma-provider.ts:168-182 (annotated)

  const name  = obj.tool ?? obj.name ?? obj.tool_name;
  const input = obj.arguments ?? obj.input ?? obj.args;
  if (typeof name !== 'string') return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  return { name, input: input as Record<string, unknown> };   // ← input AS-IS, no arg-schema check
```

This is buffr's reliability ceiling, owned by the provider: the schema said `required:['query']`, but nothing here enforces it. Wrong key → the `search_knowledge_base` handler coalesces to `''` → empty search. Because emulation is a *provider concern*, so is the ceiling — and so is the fix (validate `input` against the schema before returning). The retry that *does* exist only catches *unparseable* output (`looksLikeToolAttempt`, `gemma-provider.ts:86`), not wrong-keys-but-valid-JSON. (`04-structured-outputs.md` and `../04-agents-and-tool-use/02-tool-calling.md` walk this same gap from the contract and dispatch sides.)

**Token mapping is also a provider concern.** The same adapter that fakes tools also normalizes Ollama's idiosyncratic count fields into aptkit's `usage` shape — another piece of provider-specific mess hidden below the seam.

```
  toResponse — gemma-provider.ts:116-126 (annotated)

  usage: {
    inputTokens:  response.prompt_eval_count,   // Ollama's name → aptkit's name
    outputTokens: response.eval_count,
    estimated: false,
  }
```

The agent and the trace sink see a clean `usage` object; only the adapter knows Ollama calls them `prompt_eval_count`/`eval_count`. Swap providers and this mapping changes here, nowhere else (feeds `06-token-economics.md`).

**The embedding side — and the one-way door.** The embedder is the same pattern: a concrete `OllamaEmbeddingProvider` behind the `EmbeddingProvider` interface. But it carries a hard constraint — the 768-dim embedding is a *one-way door*, asserted at four layers.

```
  768-dim: the dimension contract, asserted top to bottom

  embedder.dimension (768)            ── OllamaEmbeddingProvider [index-cmd.ts:18]
        │ passed into
  PgVectorStore({ dimension })        ── this.dimension = opts.dimension ?? 768 [pg-vector-store.ts:29]
        │ enforced per vector
  assertDim(v): v.length !== 768 → throw  ── [pg-vector-store.ts:32-36]
        │ baked into schema
  embedding column: vector(768)       ── SQL DDL
```

Once data is indexed at 768, you can't change the embedder to a different dimension without re-indexing — the `assertDim` guard throws on a wrong-length vector before it ever reaches SQL. The provider abstraction makes the *embedder* swappable in principle, but the dimension contract makes it a re-index in practice. Naming that constraint is part of understanding the seam.

#### Move 2 variant — the load-bearing skeleton

The pattern's kernel; name each part by what breaks without it.

```
  Kernel — provider abstraction

  1. an INTERFACE (ModelProvider)   — drop it → agent couples to Gemma; no swap, no mock
  2. a concrete ADAPTER (Gemma...)  — drop it → nothing actually talks to Ollama
  3. a FACTORY / composition root   — drop it → concrete types leak into every layer
  4. (here) EMULATION inside the    — drop it → Gemma can't tool-call at all;
     adapter                          the agent loop has no structured action

  hardening (optional): the DECORATOR (guard), token-field mapping,
  retry-on-unparseable, arg-schema validation (the missing one).
```

The forgotten-but-load-bearing part is **#1, the interface** — people build the adapter and the factory and skip the interface, hard-coding the concrete type into the caller. Without the interface there's no seam: no swap, no decorator, no mock, no test double. And buffr's special #4 — emulation living *inside* the adapter — is what lets a tool-less model satisfy a tool-calling agent at all.

#### Move 3 — the principle

A provider abstraction buys you a single seam where all provider-specific reality is contained: the agent codes against a promise, the adapter keeps the promise however it must — even by faking a capability the underlying model lacks. That containment is the whole game. It's why buffr can run a tool-calling agent on a model with no tool API, why a size-guard can nest transparently, why tokens normalize cleanly — and it's why the reliability ceiling (unvalidated tool args) and the 768-dim one-way door are *locatable*: they live at named points below one seam, not smeared across the codebase.

## Primary diagram

```
  Provider abstraction in buffr — the full swap seam

  ┌─ Agent (aptkit) — codes to INTERFACES ─────────────────────────────────┐
  │  RagQueryAgent({ model: ModelProvider, tools, ... })  [rag:33]         │
  │  runAgentLoop → model.complete(request)  ← knows only the contract      │
  └───────────────────────────────┬─────────────────────────────────────────┘
        ══════════════ INTERFACE SEAM (the swap point) ═══════════════
  ┌─ Provider layer (buffr factory: src/session.ts) ───────────────────────┐
  │  model = ContextWindowGuardedProvider( ─── decorator [guard:57]         │
  │            GemmaModelProvider )         ─── adapter   [session:46]       │
  │            │                                                            │
  │            ├─ buildSystemText: schema → prompt   [gemma:137] ┐ EMULATION │
  │            ├─ parseToolCall: text → {name,input} [gemma:168] ┘ (no       │
  │            │     input AS-IS → reliability ceiling             validation)│
  │            └─ toResponse: prompt_eval_count → usage [gemma:116]          │
  │  embedder = OllamaEmbeddingProvider [session:40]                        │
  │  store    = PgVectorStore(dimension=768) — assertDim [pgvs:32]          │
  └───────────────────────────────┬─────────────────────────────────────────┘
                                  ▼  HTTP / SQL
        Ollama (gemma2:9b, nomic-embed-text:v1.5)  ·  Postgres+pgvector
```

## Elaborate

The interface/adapter/factory trio is the oldest swap pattern in software, and it's everywhere in AI engineering because the provider landscape churns — models, hosts, and pricing change monthly, so coupling your agent to one concrete client is a liability. The decorator on top (the guard) is the open-closed principle in action: add behavior by wrapping, not by editing the thing wrapped.

The genuinely interesting, AI-specific wrinkle in buffr is *capability emulation inside the adapter*. Native tool-calling (function calling) is a model feature some models have and `gemma2:9b` doesn't. Rather than restrict the agent to tool-capable models, aptkit's adapter pretends: render schemas as prompt text, parse JSON back. This is the same trick every "tool use on a base model" library uses, and it has the same well-known weakness — without constrained decoding or schema validation, the parse is best-effort, which is buffr's reliability ceiling. The fix is also locatable precisely because of the abstraction: validate the parsed args against the schema *in the adapter or at the tool boundary*, and the rest of the system is unaffected.

Connections fan out from here: `04-structured-outputs.md` (the contract view of the same emulation), `../04-agents-and-tool-use/02-tool-calling.md` (the dispatch view), `06-token-economics.md` (the `toResponse` token mapping), `02-tokenization.md` (the guard's estimate that the decorator uses), and `../03-retrieval-and-rag/01-embeddings.md` (the embedder behind `EmbeddingProvider` and its 768-dim door).

## Project exercises

No curriculum file present; exercises derived from the codebase. This concept is **deeply exercised** (Case A) — buffr is built on these interfaces.

### EX-08-1 — Add a mock ModelProvider for deterministic tests

- **Exercise ID:** EX-08-1
- **What to build:** A `MockModelProvider implements ModelProvider` that returns scripted responses (a canned tool call, then a canned answer), and a test that runs the agent against it — no Ollama required.
- **Why it earns its place:** Proves the seam's payoff: you can test the loop without the model. The interface is exactly what makes this possible.
- **Files to touch:** new `src/test-support/mock-model-provider.ts`; a test wiring it into `RagQueryAgent` the way `src/session.ts:57` does. Do not edit aptkit.
- **Done when:** an agent test runs green with no network, driven entirely by the mock.
- **Estimated effort:** 1-4hr

### EX-08-2 — Validate emulated tool args in a buffr-side wrapper

- **Exercise ID:** EX-08-2
- **What to build:** A decorator around the tool handler (or the registry) that validates the model's `arguments` against `tool.definition.inputSchema` before dispatch, turning buffr's reliability ceiling (wrong key → silent empty search) into a caught error or re-ask — without editing aptkit's `parseToolCall`.
- **Why it earns its place:** Attacks the named ceiling from buffr's side, using the same wrap-don't-edit discipline the guard demonstrates. The single highest-value robustness change in the section.
- **Files to touch:** `src/session.ts:43-44` (wrap the handler/registry), new `src/validate-tool-args.ts`.
- **Done when:** a tool call with a wrong key produces a logged error/`warning` instead of an empty-string search, proven by a test.
- **Estimated effort:** 1-2 days

### EX-08-3 — Document the provider-swap checklist

- **Exercise ID:** EX-08-3
- **What to build:** A short note enumerating exactly what changes to swap `GemmaModelProvider` for another model (factory line in `session.ts`, token-field mapping, whether the new model has native tools so emulation can drop, the 768-dim re-index if the embedder changes).
- **Why it earns its place:** Forces you to name every provider-specific concern the seam contains — the real test of understanding the abstraction.
- **Files to touch:** a new doc in buffr's repo; references `src/session.ts:40-46`, `gemma-provider.ts:116,137,168`, `pg-vector-store.ts:32`.
- **Done when:** the note lists every file a swap touches and why the rest is untouched.
- **Estimated effort:** 1-4hr

## Interview defense

**Q: "gemma2:9b has no tool-calling API. How does buffr run a tool-calling agent on it?"**

The provider emulates it. `GemmaModelProvider.buildSystemText` renders the tool schemas into the system prompt as text and asks for one JSON object; `parseToolCall` parses the model's text back into `{name, input}`. The agent above the interface seam thinks it's doing native tool-calling — the faking is entirely inside the adapter.

```
  emulation, below the seam

  agent: request.tools ──► [seam] ──► schema → prompt text → model
  agent: tool_use block ◄─ [seam] ◄── parse JSON back
```

*Anchor:* `buildSystemText` at `gemma-provider.ts:137`, `parseToolCall` at `:168`.

**Q: "Where's the weakness in that emulation, and where would you fix it?"**

`parseToolCall` returns the model's arguments as-is — no validation against the schema's `required:['query']`. A wrong key passes through and the handler coalesces to an empty search, silently. That's the reliability ceiling. The fix lives at the same seam: validate `input` against `inputSchema` in the adapter (or wrap the tool handler buffr-side) before dispatch.

```
  the ceiling and its fix, same seam

  parseToolCall → input AS-IS → wrong key → empty search   ✗
  + validate(input, inputSchema) → reject/re-ask           ✔
```

*Anchor:* unvalidated return at `gemma-provider.ts:168-182`; the empty-search coalesce at `search-knowledge-base-tool.ts:79`.

**Q: "What does the agent need to know about the model?"**

Only the `ModelProvider` interface — that it has `.complete(request)`. It never imports the concrete `GemmaModelProvider`. That single fact is what lets buffr wrap the model in a context guard, swap it, or mock it; concrete types appear only in the factory, `session.ts`.

```
  interface seam = swap point

  agent → ModelProvider (contract)
            ▲ wired in ONE place: session.ts:46
```

*Anchor:* `model: ModelProvider` at `rag-query-agent.ts:33`; assembly at `src/session.ts:46`.

## See also

- `04-structured-outputs.md` — the contract view of the tool-call emulation.
- `../04-agents-and-tool-use/02-tool-calling.md` — the dispatch view of the same seam.
- `06-token-economics.md` — the `toResponse` token mapping this adapter does.
- `02-tokenization.md` — the estimate the context-guard decorator uses.
- `../03-retrieval-and-rag/01-embeddings.md` — the `EmbeddingProvider` and the 768-dim one-way door.
