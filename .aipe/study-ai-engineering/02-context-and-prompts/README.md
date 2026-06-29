# 02 · Context and Prompts

> The container the model thinks inside, and how you shape what goes in it.

You came from frontend. You already know the instinct here, even if the name is new: a component re-renders from exactly the props you pass it, nothing more. An LLM is the same — it "knows" only what is in the bytes you hand it this call. There is no hidden `this`, no closure over last turn, no module-level state the model reads on its own. Everything it reasons over, you assembled.

This sub-section is about that assembly. Three concepts, in dependency order:

```
02-context-and-prompts/
│
│   the container ─────────────► what you put in it ───────► how you split the work
│
├── 01-context-window.md      ★ the finite token budget (gemma2:9b's 8192)
│                               what fits per turn, what gets truncated, what
│                               is NOT carried (no per-turn history)
│
├── 02-lost-in-the-middle.md  ★ position bias inside that budget — the model
│                               attends to the edges, neglects the middle.
│                               buffr's defense is a SMALL retrieved set
│
└── 03-prompt-chaining.md     ★ splitting one job into steps with one job each.
                                buffr's index→query split + tool-turn→synthesis-turn
```

## Reading order

Read them in number order. They build:

1. **`01-context-window.md`** — first, because everything else is a fight over this budget. You cannot reason about position bias or chaining until you can see the 8192-token box and what buffr packs into it every turn.
2. **`02-lost-in-the-middle.md`** — second. Now that you know the box is finite, this is the failure mode *inside* a full box: stuff buried mid-context gets under-read. buffr's answer is to keep the box from filling up in the first place.
3. **`03-prompt-chaining.md`** — third. When one prompt in one box can't do the job cleanly, you split it across boxes. This is the bridge into agents.

## Phase 1 anchor

The driving exercise for this sub-section is **prompt chaining**:

> **[C1.2]** Prompt chaining — give each model call exactly one job, then wire the outputs.

buffr today is honestly *not* a multi-LLM-call chain. Its clearest chain is the **index→query split** (offline embed-and-store vs. online embed-and-retrieve), plus the agent loop's **tool-call turn → synthesis turn**. `03-prompt-chaining.md` names what a real query-rewrite chain would add and where it would slot in. That gap is the primary target of [C1.2].

## Cross-links

- **`../01-llm-foundations/`** — what a token is, why generation is autoregressive, why the budget is a budget. The context window file assumes you've internalized "the model is a fixed-size function of its input."
- **`../03-retrieval-and-rag/`** — retrieval is how buffr keeps the context window from overflowing. `02-lost-in-the-middle.md` points specifically at `../03-retrieval-and-rag/07-reranking.md` for the not-yet-built fix (ordering best-doc-to-the-edge).
- **`../04-agents-and-tool-use/`** — the agent loop (`runAgentLoop`, `maxTurns:6`, `maxToolCalls:4`) is where the multi-turn version of context and chaining lives. This sub-section is the per-turn view; that one is the across-turns view.
