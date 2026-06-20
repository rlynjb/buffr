# The assembled prompt — buffr's whole prompt in one frame

**Industry name(s):** Prompt assembly / system-prompt composition · *Project-specific orientation*

---

## Zoom out, then zoom in

You asked buffr a question. Before a single token reaches Gemma, four
separate pieces of text get stitched into one system prompt, the tools
get rendered into that same text (because Gemma can't take them any
other way), and your question rides in as the user message. Here's the
whole thing as bands — where each piece is born, and where it lands.

```
  Zoom out — where the prompt gets assembled

  ┌─ buffr CLI (your repo) ──────────────────────────────────────┐
  │  ask-cmd.ts: loadProfile() ──► profile string                │
  │              new RagQueryAgent({ model, tools, profile })     │
  └───────────────────────────────┬──────────────────────────────┘
                                   │  profile + question
  ┌─ aptkit agent (library) ──────▼──────────────────────────────┐
  │  RagQueryAgent ctor:                                          │
  │   ★ injectProfile(BASE_SYSTEM, profile) ★  ← THIS GUIDE       │
  │   renderPromptTemplate(...)                                   │
  │  runAgentLoop: system + (synthesis nudge on final turn)       │
  └───────────────────────────────┬──────────────────────────────┘
                                   │  system + messages + toolSchemas
  ┌─ Gemma provider (library) ────▼──────────────────────────────┐
  │  buildSystemText: BASE_SYSTEM + profile                       │
  │                 + "You can call the following tools:" + JSON  │
  │                 + "respond with ONLY a single JSON object"    │
  └───────────────────────────────┬──────────────────────────────┘
                                   │  HTTP POST /api/chat
  ┌─ Ollama (local) ──────────────▼──────────────────────────────┐
  │  gemma2:9b  →  text (maybe a JSON tool call, maybe prose)     │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: there is no single "prompt file" in buffr. The prompt is
**composed at three layers** — your CLI hands in a profile, the aptkit
agent prepends it to a baked-in grounding instruction, and the Gemma
provider appends the tool catalog as text. The job of this guide is to
name each piece, say which layer owns it, and ground it in real code.

---

## The four pieces and who owns them

Every prompt buffr sends is these four pieces, in this order. The first
column is the prompt-anatomy term; the last is the exact owner.

```
  The assembled system prompt — four pieces, three owners

  ┌──────────────────────┬────────────────────────┬──────────────────────┐
  │ piece                │ what it is             │ owner (file:line)    │
  ├──────────────────────┼────────────────────────┼──────────────────────┤
  │ 1. profile block     │ me.md-style standing   │ ask-cmd.ts:27 loads  │
  │    "# About the      │ context about YOU      │ profile-injector.ts  │
  │    person..."        │ (per-user, ~constant)  │ :15 prepends it      │
  ├──────────────────────┼────────────────────────┼──────────────────────┤
  │ 2. BASE_SYSTEM       │ "search first, ground, │ rag-query-agent.js   │
  │    grounding         │ cite, say so if you    │ :12-19 (the          │
  │    contract          │ don't know" (constant) │ DEFAULT template)    │
  ├──────────────────────┼────────────────────────┼──────────────────────┤
  │ 3. tool catalog      │ tool schemas as JSON   │ gemma-provider.js    │
  │    (Gemma only)      │ + "respond with ONLY   │ :82-105 buildSystem  │
  │                      │ a single JSON object"  │ Text                 │
  ├──────────────────────┼────────────────────────┼──────────────────────┤
  │ 4. synthesis nudge   │ "NO more tool calls.   │ run-agent-loop.js    │
  │    (final turn only) │ Now answer, cite."     │ :17-19, applied :30  │
  └──────────────────────┴────────────────────────┴──────────────────────┘

  the user message (your question) is NOT in the system prompt —
  it rides as messages[0] (ask-cmd.ts:34 → runAgentLoop:22)
```

The split that matters: **pieces 1 and 2 are constant per session**
(profile + grounding rules), **piece 3 is constant per turn** (tools
don't change mid-loop), and **piece 4 appears only on the last turn**.
That's textbook prompt anatomy — system holds the constant, user holds
the per-call. Mixing them is how prompts drift. buffr keeps them in
separate layers, which is why you can reason about each piece alone.

---

## Where the deep walks live

This overview is the map. Each piece gets its own pattern file:

- Piece 1 → [`01-profile-injection-as-personalization.md`](01-profile-injection-as-personalization.md)
- Piece 2 → [`02-grounding-and-citation-instruction.md`](02-grounding-and-citation-instruction.md)
- Piece 3 → [`03-tool-call-emulation-prompt.md`](03-tool-call-emulation-prompt.md)
- Piece 4 → [`05-bounded-synthesis-nudge.md`](05-bounded-synthesis-nudge.md)
- The JSON validate/retry machinery → [`04-structured-output-reprompt.md`](04-structured-output-reprompt.md)

And the lens-by-lens audit (including everything buffr does **not** do)
lives in [`audit.md`](audit.md).

---

## The principle

A production prompt is rarely one string in one file. It's **assembled**
— composed across the layers that each own a piece of the constant. The
discipline isn't "write a good prompt," it's "keep each piece in the
layer that owns it, so a model upgrade or a profile change touches one
piece, not all four." buffr's three-layer split (CLI profile → library
grounding → provider tool catalog) is that discipline made concrete.

---

## See also

- [`audit.md`](audit.md) — every lens, including the gaps
- [`study-agent-architecture/00-overview.md`](../study-agent-architecture/00-overview.md)
  — the runtime that drives this prompt
