# Gemma tool-call emulation — prompt-and-parse instead of native tools

> Updated: 2026-06-24 — emulation mechanics unchanged; `ask`/`ask-cmd.ts` references retargeted to the `chat`/`session.ts` surface.

**Industry name(s):** Tool-call emulation / JSON-mode tool calling for non-tool models · Project-specific (forced by the model choice).

## Zoom out, then zoom in

Here's the risk at the center of buffr. The agent loop (`03`) assumes the model can request a tool. But buffr's model is **stock `gemma2:9b`, which has no native tool-calling API** — no `tools` parameter, no structured `tool_use` response. So the Gemma provider *fakes* it: it renders the tool schema into the system prompt and parses a JSON object back out of free text. This is the single most fragile seam in the system.

```
  Zoom out — where emulation lives

  ┌─ Agent loop ─────────────────────────────────────────────┐
  │  runAgentLoop expects response.content with tool_use blocks│
  └───────────────────────────┬──────────────────────────────┘
                              │  model.complete(system, msgs, tools)
  ┌─ Provider layer ──────────▼──────────────────────────────┐
  │  ★ GemmaModelProvider ★                                   │ ← we are here
  │   OUT: render tools → system text, demand JSON-only       │
  │   IN:  parseToolCall(raw text) → tool_use  OR  text       │
  └───────────────────────────┬──────────────────────────────┘
                              │  /api/chat (stream:false)
  ┌─ Ollama ──────────────────▼──────────────────────────────┐
  │  gemma2:9b — plain text in, plain text out, no tool API   │
  └───────────────────────────────────────────────────────────┘
```

Zoom in: the loop speaks "tool_use blocks." Gemma speaks "text." The provider is the adapter between those two languages, and it adapts in both directions — outbound it teaches Gemma the tool contract in prose, inbound it parses Gemma's text guess back into the structured shape the loop needs. When Gemma returns slightly-wrong JSON, this is where the run lives or dies.

## Structure pass

Two halves, one axis: **what's the data contract, and who enforces it?**

```
  Axis traced = "the tool-call contract — who enforces it?"

  ┌─ OUTBOUND: buildSystemText ─────────┐  contract = PROSE INSTRUCTION
  │  render tool schema into system text │  → enforced by hope (prompt)
  │  "respond with ONLY {tool,arguments}"│
  └──────────────────┬───────────────────┘
                     │  seam — prose instruction ═╪═ raw model text
                     │  (the contract is unenforced across this line)
  ┌─ INBOUND: parseToolCall ────────────┐  contract = JSON PARSE + RETRY
  │  parseAgentJson(text) → {tool,args}? │  → enforced by code + 1 nudge
  │  null? looksLikeToolAttempt? retry   │
  └──────────────────────────────────────┘
```

The seam is the whole story: **the tool-call contract is a prose instruction the model may or may not follow, and the only enforcement is on the way back in.** A native-tool model (Claude, GPT-4) enforces the schema at generation time — the API guarantees a well-formed tool call. Gemma guarantees nothing; the provider compensates with a forgiving parser and exactly one corrective retry. That asymmetry — strong contract on native models, best-effort on Gemma — is the risk you accept to run fully local and free.

## How it works

Mental model: you know how a form `<input>` with no validation lets the user type anything, so you validate and re-prompt on submit? Emulation is that. The system prompt is the form label ("type JSON like this"); `parseToolCall` is the submit validator; the retry nudge is "that wasn't valid, try again."

```
  Tool-call emulation — prompt out, parse in, retry once

  OUTBOUND                              INBOUND
  ┌────────────────────────┐           ┌──────────────────────────┐
  │ system += "tools: {...}│           │ raw = model text         │
  │  respond ONLY with     │           │ parseAgentJson(raw)      │
  │  {tool, arguments}"    │           │   ├─ {tool,args}? → emit │
  └───────────┬────────────┘           │   │    tool_use block    │
              │ /api/chat               │   └─ null:               │
              ▼                         │      looksLikeToolAttempt│
        gemma2:9b ──────── raw text ───►│      (has '{')?          │
              ▲                         │      ├ yes → RETRY+nudge │
              │  retry with nudge ◄─────┤      └ no  → emit as text│
              └─────────────────────────┘  (max 2 attempts total)  │
                                          └──────────────────────────┘
```

### Step 1 — outbound: render the tool schema into the system prompt

When the loop passes a `tools` array, `buildSystemText` JSON-stringifies each tool's name, description, and input schema and appends: *"You can call the following tools: ... When a tool is needed, respond with ONLY a single JSON object, no prose: `{"tool": "<name>", "arguments": {...}}`. Otherwise answer directly."* The tool definition that goes in here is the one buffr built — `search_knowledge_base` with its `query`/`top_k`/`filter` schema. Boundary condition: this is pure instruction. Nothing stops Gemma from wrapping the JSON in prose, using markdown fences, or ignoring the format entirely.

### Step 2 — inbound: parse the text back into a tool call

`parseToolCall(raw)` runs `parseAgentJson` (a lenient parser that tolerates surrounding prose/fences), then checks for a `tool`/`name`/`tool_name` field and an `arguments`/`input`/`args` object. If both are present, it's a tool call — the provider emits a `tool_use` block with a synthetic id (`gemma-search_knowledge_base-0`). The multi-key tolerance (accepting `name` OR `tool`, `input` OR `arguments`) is deliberate: Gemma drifts on field names, and the parser meets it partway.

### Step 3 — the retry-or-accept decision

If parsing fails, the provider asks: did the model *try* to call a tool? The tell is cheap — `looksLikeToolAttempt` just checks whether the text contains a `{`. If yes, it's a botched tool call: append the retry nudge (*"Your previous reply was not a valid tool call. Respond with ONLY..."*) and try once more (`maxToolCallAttempts` defaults to 2 → one retry). If no `{`, it's plain prose — a real natural-language answer — so accept it as text and stop. Boundary condition: this `{`-heuristic is itself fallible. A prose answer that happens to contain a `{` (a code snippet, a set in text) triggers a wasted retry; a malformed tool attempt with no `{` gets accepted as a (nonsensical) answer.

### Move 2 variant — the load-bearing skeleton

```
  Emulation kernel — remove any part and it breaks

  ┌─ render tools into system text ─────────────────────────┐
  │  drop it → Gemma has no idea the tool exists; never calls│
  ├─ "respond with ONLY JSON" instruction ──────────────────┤
  │  drop it → Gemma answers in prose, no tool call parsed   │
  ├─ lenient parseAgentJson (tolerate fences/prose) ────────┤
  │  drop it → strict JSON.parse fails on Gemma's fenced     │
  │  output; valid tool calls get dropped                    │
  ├─ multi-key field tolerance (tool|name, args|input) ─────┤
  │  drop it → Gemma's field-name drift breaks valid calls   │
  ├─ retry-with-nudge on botched JSON ──────────────────────┤
  │  drop it → one bad generation = no tool call this turn,  │
  │  burning a loop turn on nothing                          │
  └──────────────────────────────────────────────────────────┘
```

Skeleton vs hardening: all five are load-bearing for a weak model. The hardening that's *absent*: there's no schema validation of the `arguments` against the tool's `inputSchema` before calling — if Gemma emits `{tool: "search_knowledge_base", arguments: {q: "..."}}` (wrong key), the parser accepts it and the tool handler quietly coerces a missing `query` to `''`, searching for empty string. That's a silent-bad-retrieval path worth knowing.

### Move 3 — the principle

When the model can't enforce the tool contract, the runtime must. The principle: emulation moves the schema guarantee from generation-time (native tools) to parse-time (your code), and parse-time enforcement is always best-effort — forgiving on the way in, one corrective retry, then degrade to text. The cost of "local and free" is that every tool call is a string you have to parse and pray over.

## Primary diagram

The full emulation round-trip, both directions and the retry branch.

```
  buffr Gemma tool-call emulation — full recap

  loop: model.complete({system, messages, tools:[search_kb]})
     │
     ▼  GemmaModelProvider.complete
  ┌──────────────────────────────────────────────────────────┐
  │ buildSystemText: system + rendered tool JSON +            │
  │   "respond ONLY with {tool, arguments}"                   │
  └───────────────────────────┬──────────────────────────────┘
                  attempt 0    │     attempt 1 (+ RETRY_NUDGE)
                              ▼
                    POST /api/chat (stream:false) → raw text
                              │
              ┌───────────────┴────────────────┐
              ▼  parseToolCall(raw)             │
        ┌─────┴──────┐                          │
        │ {tool,args}?│ yes → tool_use block ───┴──► back to loop
        └─────┬──────┘
              │ no
        ┌─────┴────────────────┐
        │ looksLikeToolAttempt │ yes & attempts left → retry w/ nudge
        │ (text has '{')       │ no → emit as text block (real answer)
        └──────────────────────┘
```

## Implementation in codebase

**Use cases.** Runs on every model turn inside `chat` where the loop offers tools (every turn except the forced-final one). buffr's decision to use Gemma — a free, local, no-native-tools model — is what makes emulation necessary. Choose a native-tool model and this entire layer disappears.

**Code side by side.** The emulation logic lives in the library's `GemmaModelProvider` (buffr consumes it unchanged), but buffr's choice at the call site is what activates it:

```
  src/session.ts  (line 46)

  const model = new ContextWindowGuardedProvider(
    new GemmaModelProvider({ host: cfg.ollamaHost }), { maxTokens: 8192 });
       │                    │
       │                    └─ GemmaModelProvider = the emulation adapter.
       │                       Pick AnthropicProvider here and native tools
       │                       replace the whole prompt-and-parse dance
       └─ the context guard wraps it: the rendered tool JSON eats into the
          8192-token budget, so a big tool schema competes with the corpus
```

```
  library GemmaModelProvider — the inbound contract (for grounding)

  const call = parseToolCall(raw);
  if (call) return toResponse([{ type:'tool_use', ... }]);
  if (looksLikeToolAttempt(raw)) continue;   ← retry only on a '{'-bearing miss
  ...
  return toResponse([{ type:'text', text: raw }]);  ← otherwise it's a real answer
       │
       └─ the '{' heuristic is the cheap tell. It's fallible both ways: a prose
          answer containing '{' wastes a retry; a JSON-less bad call is accepted
          as text. buffr inherits this; it's the documented risk of emulation
```

## Elaborate

Tool-call emulation predates native tool APIs — it's how everyone did "function calling" before OpenAI/Anthropic shipped structured tools. The pattern survives because open models (Gemma, base Llama, Mistral) still often lack native tools, and running local-and-free means accepting it. The library's implementation is a clean version: render-to-prompt, lenient-parse, one-nudge-retry, accept-prose-as-answer.

The honest framing for buffr: this is the ceiling on agent reliability. No amount of retrieval quality fixes a turn where Gemma emits malformed JSON and the parser gives up. The two cheapest hardenings — validating `arguments` against the tool's `inputSchema`, and a smarter "is this a tool attempt" check than `includes('{')` — would both live in a buffr-side wrapper around the provider, since the library itself is off-limits to edit.

What to read next: `03-agent-loop-with-tool-calling.md` (the loop that consumes the emulated `tool_use`), and `06-evals-precision-and-recall.md` (why a faithfulness eval would catch emulation failures that retrieval scoring can't).

## Project exercises

> No `aieng-curriculum.md` present; exercises name the buildable target directly.

### Validate tool arguments against the input schema

- **What to build:** A buffr-side wrapper around the search tool's handler (or the registry) that validates `args` against `search_knowledge_base`'s `inputSchema` and rejects a call with a missing/empty `query` instead of searching for `''`.
- **Why it earns its place:** Closes the silent-bad-retrieval path — "I found that emulated tool calls with the wrong argument key searched for empty string, and I added schema validation at the boundary" is a precise, real bug story.
- **Files to touch:** `src/session.ts` (wrap `tool.handler`), optionally a new `src/tool-guard.ts`.
- **Done when:** a test feeding `{arguments: {q: "x"}}` (wrong key) gets a clear error fed back to the loop, not an empty-string search.
- **Estimated effort:** 1–4hr.

### Measure emulation failure rate

- **What to build:** An eval that runs N fixed questions through `chat` and counts how often Gemma needed the retry nudge vs. emitted clean JSON on the first attempt.
- **Why it earns its place:** Quantifies the reliability ceiling — "my tool-call emulation succeeds first-try 80% of the time" is a number most candidates can't produce about their own agent.
- **Files to touch:** new `src/cli/emulation-eval-cmd.ts`, a transport/trace hook to count attempts.
- **Done when:** the command prints a first-try success rate over a fixed question set.
- **Estimated effort:** 1–2 days.

## Interview defense

**Q: Your model has no tool API. How does the agent call a tool?**

```
  OUT: tool schema → system prompt, "respond ONLY {tool,arguments}"
  IN:  parse JSON from text → tool_use, else retry once, else accept as answer
```

"Gemma2:9b has no native tools, so the provider emulates: it renders the tool schema into the system prompt and demands a JSON object, then parses that object back out of the model's text. If parsing fails on something that looks like a botched call, it retries once with a corrective nudge." Anchor: emulation moves the schema guarantee from generation-time to parse-time.

**Q: Where does this break, and what's the fix?**

The `includes('{')` retry heuristic and the lack of argument validation. "A prose answer with a brace wastes a retry; a wrong-key tool call searches for empty string silently. The fix is buffr-side schema validation of the arguments before calling the tool — I can't edit the library, so it goes in a wrapper." Anchor: parse-time enforcement is always best-effort; harden it at your own boundary.

## Validate

- **Reconstruct:** Draw the emulation round-trip from memory: outbound render, inbound parse, the retry-or-accept branch. (library `GemmaModelProvider.complete`)
- **Explain:** Why does the provider retry only when the text contains `{`? What two failure modes does that heuristic have? (`looksLikeToolAttempt`)
- **Apply:** Gemma returns `{"tool":"search_knowledge_base","input":{"query":"coffee"}}` — note `input` not `arguments`. Does it work? Trace `parseToolCall`. (multi-key tolerance: `obj.arguments ?? obj.input ?? obj.args`)
- **Defend:** buffr chose Gemma over a native-tool cloud model. Defend that for a local personal RAG agent, then name the reliability cost. (`src/session.ts:46`)

## See also

- `03-agent-loop-with-tool-calling.md` — the loop that consumes the emulated `tool_use` blocks.
- `02-rag-query-path.md` — what the tool actually runs once a call is parsed.
- `06-evals-precision-and-recall.md` — why faithfulness evals would catch emulation failures.
- `.aipe/study-system-design/04-library-as-dependency-boundary.md` — why the provider can't be edited, so hardening goes in a wrapper.
