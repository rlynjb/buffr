# 02 — Context and Prompts

**Anchor:** LLM application engineering — the finite container the model reasons inside, and how you arrange what goes in it.
**Curriculum:** Phase 1, C1.2 (context window + lost-in-the-middle) plus prompt chaining as the bridge into the agent sections.

Everything an LLM "knows" in a single call is the text you handed it. There is no hidden memory, no database it queries on its own — just one flat string (system prompt + history + question) that has to fit inside a fixed token budget. This section is about that budget, about where in the string the model actually pays attention, and about whether you do the reasoning in one shot or break it into steps.

buffr makes exactly one of these a hard, mechanical thing — the context window is bounded at 8192 tokens by a guard that *estimates and refuses* before overflow. The other two it leaves mostly implicit, and the files say so plainly.

## Files in this section

| File | Concept | In buffr? |
|------|---------|-----------|
| `01-context-window.md` | The finite container; `ContextWindowGuardedProvider` estimates tokens (~3 chars/token) and throws before Ollama can truncate silently | **EXERCISED** — the richest file. `src/session.ts:46` wires the guard at `maxTokens: 8192`. |
| `02-lost-in-the-middle.md` | Models attend to the start and end of the window and skim the middle | **Implicit only.** buffr retrieves few chunks (`minTopK: 4`) and injects the profile at `'start'` — but never deliberately orders chunks by position. Honest; Case B exercise. |
| `03-prompt-chaining.md` | Decomposing a task into a fixed sequence of single-job LLM calls | **NOT YET EXERCISED as a chain.** buffr runs one agent loop where the *model* picks steps; that's not a chain. Cross-links to `04-agents-and-tool-use/01-agents-vs-chains.md`. Case B exercise. |

## The one thing to take from this section

The window is a budget and a competition. System prompt, injected profile (`me.md`), every retrieved chunk, and the question all draw from the same 8192 tokens. buffr's guard turns "we overflowed and Ollama quietly cut off the oldest text" into a loud, catchable `ContextWindowExceededError` — and that decision (estimate, then refuse) is the load-bearing idea of the whole section.

## See also

- `01-llm-foundations/06-token-economics.md` — what a token costs and where buffr persists usage.
- `03-retrieval-and-rag/11-rag.md` — what fills most of the window: the retrieved chunks.
- `04-agents-and-tool-use/01-agents-vs-chains.md` — the agent-vs-chain distinction that `03-prompt-chaining.md` leans on.
- `04-agents-and-tool-use/05-agent-memory.md` — retrieval-based episodic memory, which fills the gap left by buffr having no in-prompt turn history.
