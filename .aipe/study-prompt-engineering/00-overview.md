# Overview — the prompt nobody fully owns

One page to orient. The thing to internalize before anything else: in this repo
there is no single file you can open and read "the prompt." The string that
finally reaches Ollama is **assembled across three owners**, each appending to
what the last one produced.

I have debugged this exact shape in production more than once — a prompt that
"looks fine" in your code because the part you wrote *is* fine, and the failure
lives in a layer you don't own. So before mechanics, here's the whole machine.

```
  Prompt assembly — three owners, one string

  ┌─ Owner 1: buffr (this repo) ──────────────────────────────┐
  │  loadProfile(pool, appId)         src/profile.ts:4         │
  │    → reads me.md text from agents.profiles                 │
  │  new RagQueryAgent({ profile })   src/session.ts:57        │  ← we start here
  └───────────────────────────┬───────────────────────────────┘
                              │ profile string handed in
  ┌─ Owner 2: aptkit RagQueryAgent ──▼────────────────────────┐
  │  injectProfile(BASE_SYSTEM, profile, {position:'start'})   │
  │    rag-query-agent.js:29-31                                │
  │    → "# About the person…\n<me.md>\n\n<BASE_SYSTEM>"       │
  │  BASE_SYSTEM = "call search first, ground, cite sources"   │
  └───────────────────────────┬───────────────────────────────┘
                              │ system string + tool schemas
  ┌─ Owner 3: Gemma provider ────────▼────────────────────────┐
  │  buildSystemText(request)         gemma-provider.js:82     │
  │    → system + "You can call the following tools:" +        │
  │      JSON.stringify(each tool) + "respond ONLY a JSON      │
  │      object {tool, arguments}"                             │
  └───────────────────────────┬───────────────────────────────┘
                              │ final messages[]
                              ▼
                       Ollama /api/chat  (gemma2:9b)
```

**Why this matters and not just "it's layered":** the load-bearing capability in
this app — calling the search tool to retrieve knowledge — is decided entirely in
Owner 3, and it's *emulated*. Gemma 2 9B served by Ollama has no native tool API.
So aptkit doesn't pass a `tools` array to a tool endpoint; it renders the tool
catalog into **text** inside the system prompt and asks the model to reply with a
JSON object it then parses back (`gemma-provider.js:107`). Tool calling here is a
prompt-engineering trick, not an API feature. If the model returns prose instead
of JSON, there's exactly one retry, gated on a cheap `{`-tell.

The rest of the prompt machinery is comparatively calm:

- **Grounding + citation** is one instruction in `BASE_SYSTEM`
  (`rag-query-agent.js:12-19`): *call search first, ground every answer, cite
  sources.* It works not because the instruction is strong but because the search
  tool returns **pre-formatted citations** (`[docId] snippet`,
  `search-knowledge-base-tool.js`) that the model copies. Nothing validates that
  it actually did.
- **Profile injection** (`me.md` → system prompt) is the entire personalization
  story — one prepend, no extra model call.
- **Bounded synthesis** is a forced final turn ("you have NO more tool calls,
  now answer and cite") that stops the agent loop from spinning
  (`run-agent-loop.js:17,30`).
- **Structured-output reprompt** (generate → validate → retry with a strict
  JSON-only suffix) exists in aptkit (`structured-generation.js`) but is **not on
  buffr's chat hot path** — it's the meta-agents' machinery, available to grow into.

```
  The five prompt patterns, by how load-bearing they are

  ┌────────────────────────────────┬──────────────┬─────────────────────┐
  │ pattern                        │ load-bearing │ where it lives      │
  ├────────────────────────────────┼──────────────┼─────────────────────┤
  │ tool-call emulation            │ ★★★ critical │ gemma-provider.js   │
  │ grounding + citation instr.    │ ★★           │ rag-query-agent.js  │
  │ profile injection              │ ★★           │ profile-injector +  │
  │                                │              │ rag-query-agent.js  │
  │ bounded synthesis nudge        │ ★★           │ run-agent-loop.js   │
  │ structured-output reprompt     │ ★ (off-path) │ structured-gen.js   │
  └────────────────────────────────┴──────────────┴─────────────────────┘
```

Now read [`audit.md`](audit.md) for the full 13-concept walk, then the pattern
files for the deep dives. The recommended deep-read order is in the
[`README`](README.md).
