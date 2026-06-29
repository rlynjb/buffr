# Context engineering — curating what the model sees each turn

**Industry name(s):** context engineering · context assembly · the
context window discipline. **Type label:** Industry standard.

**In this codebase: yes — buffr does deliberate context assembly.** The
system prompt is assembled from three owners (profile + base template +
retrieved chunks), the context window is guarded against overflow
(`ContextWindowGuardedProvider`), and tool results are truncated before
they re-enter the window. What buffr *doesn't* do — thread prior
conversation turns into the prompt — is itself a context-engineering
choice, the honest gap.

## Zoom out, then zoom in

Context engineering is the superset that RAG and prompt engineering are
subsets of: everything the model sees at inference time.

```
  Zoom out — context engineering as the superset

  ┌───────────────────────────────────────────────┐
  │            Context engineering                │
  │  (everything the model sees at inference time)│
  │                                               │
  │   ┌─────────────┐  ┌─────────────┐            │ ← we are here
  │   │   prompt    │  │     RAG     │            │
  │   │ (base tmpl) │  │ (chunks)    │            │
  │   └─────────────┘  └─────────────┘            │
  │   ┌─────────────┐  ┌─────────────┐            │
  │   │ user profile│  │ tool outputs│            │
  │   └─────────────┘  └─────────────┘            │
  │   ┌─────────────┐                             │
  │   │ history      │ ← buffr does NOT thread     │
  │   │ (NOT used)   │   prior turns in-prompt     │
  │   └─────────────┘                             │
  └───────────────────────────────────────────────┘
```

Zoom in: most agent failures are not model failures — they're context
failures (stale retrieval, lost-in-the-middle on a bloated window, no
user state loaded, the wrong tool outputs in the window). Context
engineering is the discipline of curating what fills the window for the
next step. buffr curates four of the five boxes above and deliberately
omits the fifth.

## Structure pass

**Layers.** The context that reaches Gemma is assembled from layers:
profile, base prompt, the question, retrieved chunks, tool results.

**Axis — "what's in the window, and who put it there?"** Profile:
`injectProfile`. Base instructions: the template. Chunks: the search
tool. Tool results: the loop. Prior turns: *nobody* — that's the gap.
Tracing this axis shows exactly what Gemma sees and what it doesn't.

**Seam.** The `model.complete(...)` call (`run-agent-loop.js:29`) — the
boundary where assembled context becomes the model's input. Everything
upstream is context engineering; the guard
(`ContextWindowGuardedProvider`) sits right at this seam to reject
overflow.

## How it works

#### Move 1 — the mental model

You assemble a component's props from several sources before you render
— some from context, some from a fetch, some from local state. Context
engineering is assembling the model's "props" (its window) from several
owners before each `complete` call.

```
  Pattern — the context assembly for one buffr turn

  ┌─ system ──────────────────────────────────────┐
  │  profile (injectProfile, "# About the person") │
  │  + base template ("always search first…")      │
  │  + synthesis instruction (only on last turn)   │
  └────────────────────┬───────────────────────────┘
  ┌─ messages ─────────▼───────────────────────────┐
  │  user question                                 │
  │  + accumulated tool_results (truncated)        │
  │  (NO prior-turn history)                       │
  └────────────────────────────────────────────────┘
```

#### Move 2 — the walkthrough

**Profile is injected before the template renders.** `RagQueryAgent`'s
constructor prepends the user profile to the system prompt
(`rag-query-agent.js:28-32`), via `injectProfile`
(`profile-injector.js:15-22`):

```ts
const withProfile = options.profile
  ? injectProfile(template, options.profile, { position: 'start', heading: PROFILE_HEADING })
  : template;
this.system = renderPromptTemplate(withProfile, {});
```

The profile is standing context — the same `me.md`-style document every
turn — loaded from `agents.profiles` (`src/profile.ts`,
`src/session.ts:47`). That's the "user profile" box of the superset,
deliberately curated. (Profile-as-context gets its own file:
`04-... → see also`.)

**Chunks enter as tool results, truncated.** Retrieved chunks come back
through the search tool and re-enter the window as a `tool_result`
message — but `runAgentLoop` caps each result at 16K chars
(`run-agent-loop.js:2-7`):

```js
const MAX_TOOL_RESULT_CHARS = 16_000;
function truncate(value) {
  if (value.length <= MAX_TOOL_RESULT_CHARS) return value;
  return `${value.slice(0, MAX_TOOL_RESULT_CHARS)}\n...[truncated]`;
}
```

That truncation is context engineering: it stops one giant tool result
from blowing the window and crowding out everything else.

**The window is guarded against overflow.** buffr wraps Gemma in
`ContextWindowGuardedProvider` with `maxTokens: 8192`
(`src/session.ts:46`). Before each call it estimates input tokens and
throws `ContextWindowExceededError` if they exceed the budget minus an
output reserve (`context-window-guard.js:27-47`). That's the hard floor
under context engineering — assembled context that won't fit is rejected
loudly, not silently truncated into garbage.

**The honest gap: no in-prompt history.** Here's the load-bearing
omission. `runAgentLoop` seeds its messages array with *only* the
current question (`run-agent-loop.js:22`): `const messages = [{ role:
'user', content: userPrompt }]`. Prior conversation turns are **not**
threaded into the window. The session comment names this directly
(`src/session.ts:25-27`): "Still missing: sequential in-prompt turn
history (RagQueryAgent.answer() treats each question independently)."
So buffr's context assembly includes profile + chunks + tool results
but *not* the conversation so far. It compensates with retrieval-based
memory (next file) — relevance recall, not in-prompt threading.

```
  Layers-and-hops — context assembled, then guarded, then sent

  ┌─ Assembly (session + agent) ─┐ hop 1  ┌─ Guard ──────────────┐
  │ profile + template + chunks  │ ─────► │ estimate tokens      │
  │ + question (NO history)      │        │ throw if > 8192-reserve│
  └──────────────────────────────┘        └──────────┬───────────┘
                                            hop 2 ok  │
                                                      ▼
                                            ┌─ Gemma2:9b ────────┐
                                            │ model.complete     │
                                            └────────────────────┘
```

#### Move 3 — the principle

Most agent failures are context failures, and bigger windows don't fix
them — they make room for more noise. The job is curating *what fills
the window for the next step*. buffr curates deliberately: profile as
standing context, chunks truncated, the window guarded — and it makes a
clear-eyed choice to omit in-prompt history, leaning on retrieval
instead. Naming what you *don't* put in the window is as much context
engineering as what you do.

## Primary diagram

```
  buffr's context engineering (per turn)

  ┌─ system prompt ────────────────────────────────┐
  │  [profile injected at start]                    │
  │  + base instructions ("always search first")    │
  │  + synthesis instruction (last turn only)        │
  └────────────────────┬────────────────────────────┘
  ┌─ messages ─────────▼────────────────────────────┐
  │  question + truncated tool_results               │
  │  ✗ NO prior-turn history (by design)             │
  └────────────────────┬────────────────────────────┘
                       ▼
              ContextWindowGuardedProvider (8192, reject overflow)
                       ▼
                   Gemma2:9b
```

## Elaborate

Context engineering reframes "prompt engineering" from "write a good
prompt" to "control everything in the window across a multi-turn loop."
The prompt-level half (writing the instructions) lives in
`.aipe/study-prompt-engineering/01-three-owner-prompt-assembly.md` —
which already names buffr's three-owner assembly. This file covers the
*discipline*: deciding what enters the window each step, including the
deliberate omission of history. The lost-in-the-middle and context-window
mechanics would be detailed in a future `study-ai-engineering` guide.

## Interview defense

**Q: How does buffr decide what the model sees each turn?**
It assembles the system prompt from three owners — profile injected at
the start, the base template, and (on the last turn) the synthesis
instruction — plus the question and truncated tool results in the
messages. The window is guarded at 8192 tokens, rejecting overflow
loudly. The deliberate omission: prior conversation turns are *not*
threaded in — each question is answered independently
(`run-agent-loop.js:22`), with retrieval-based memory compensating.

```
  profile + template + chunks + question  (NO history) → guarded → model
```

**Anchor:** "Most agent failures are context failures — buffr curates
profile, chunks, and tool results, and deliberately omits in-prompt
history."

## See also

- `02-agent-memory-tiers.md` — the retrieval memory that compensates
  for the missing history
- `05-agent-infrastructure → 05-guardrails-and-control.md` — the window
  guard as a control point
- `.aipe/study-prompt-engineering/01-three-owner-prompt-assembly.md` —
  the prompt-assembly half
- `03-multi-agent-orchestration/08-shared-state-and-message-passing.md`
  — context routing across agents
