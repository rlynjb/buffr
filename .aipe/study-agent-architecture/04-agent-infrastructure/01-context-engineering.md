# Context Engineering

*Industry names: **context engineering** / **context assembly** / **the standing context**.
Type label: Industry standard (the discipline is universal; buffr's profile-as-standing-context
assembly is Project-specific). IMPLEMENTED in buffr.*

## Zoom out, then zoom in

Every call the model makes sees exactly one thing: a context window. Context engineering is the
discipline of deciding what goes into it. In buffr that window is assembled from four sources,
and this file is about the one that is *constant across every call* — the profile.

```
  buffr's stack — the context window is assembled at the agent layer

  ┌─ Session — src/session.ts ─────────────────────────────────────┐
  │  loadProfile(:47) → fed to RagQueryAgent(:57)                  │
  └──────────────────────────┬─────────────────────────────────────┘
  ┌─ ★ CONTEXT ENGINEERING — what the model SEES ★ ───▼────────────┐
  │  the context window =                                          │
  │    system prompt  = profile + instructions   (constant)       │
  │  + messages array = the growing transcript    (per turn)       │
  │  + tool outputs   = pgvector hits fed back     (per call)       │
  └──────────────────────────┬─────────────────────────────────────┘
  ┌─ ContextWindowGuardedProvider — the guard ────────▼────────────┐
  │  wraps Gemma · maxTokens:8192 · stops overflow  (session.ts:46)│
  └─────────────────────────────────────────────────────────────────┘
```

The system prompt is the only part the engineer fully controls; the messages array and tool
outputs are written by the loop at runtime. The single most important reframe in this whole
section lives here: **most agent failures are context failures, not model failures.** A
9B model with the right context beats a frontier model with the wrong context.

## Structure pass

Three context sources, one axis: **who writes it, and when.**

```
  Axis = WHO WRITES IT · trace it across the three context sources

  system prompt   ← the ENGINEER writes it once, at construction   (constant)
                       profile (loadProfile) + instructions
  ───────────────── ★ SEAM: control passes to the loop ★ ──────────────────
  messages array  ← the LOOP writes it, every turn                 (per turn)
  tool outputs    ← the TOOL writes it, every call                 (per call)
```

The seam is construction-time versus run-time. Above it, you (the engineer) decide the standing
context once. Below it, the loop and the tools decide the rest, and you can only *bound* what
they add — which is what the guard does. The seam line is `rag-query-agent.ts:52-59` (the
constructor freezes the system prompt) versus `run-agent-loop.ts:94,124,189` (the loop appends
to messages at run time).

## How it works

### Move 1 — mental model

The context window is a single string the model reads top to bottom before every reply. Context
engineering is deciding what that string contains. Bridge from frontend: it is your local-first
storage layering, exactly. You had a *canonical-local* layer (the source of truth that's always
there) and a *retrieved-context* layer (the stuff you fetch per view). The profile is the
canonical-local layer of the context window — always present, never re-fetched per turn. The
tool outputs are the retrieved-context layer — pulled fresh per call, discarded after.

```
  THE SHAPE — the context window as two storage layers

  ┌─ canonical-local layer (constant) ──────────────────────────┐
  │  system prompt = profile + instructions                    │
  │  written ONCE at construction, read on EVERY call           │
  └─────────────────────────────────────────────────────────────┘
  ┌─ retrieved-context layer (per call) ────────────────────────┐
  │  messages array + tool outputs                              │
  │  written by the loop/tool, grows then resets per answer()   │
  └─────────────────────────────────────────────────────────────┘
                          │
                          ▼
            ┌──────────────────────────┐
            │  the guard caps the SUM  │  maxTokens:8192
            └──────────────────────────┘
```

### The profile is loaded once, from the database

Bridge from known: this is a `fetch()` that runs at construction, not per render. `loadProfile`
reads the me.md-style profile text out of Postgres for this app, and the session hands it to the
agent constructor. One read, reused for the whole session.

```ts
// src/session.ts:47,57 — load the profile once, inject it into the agent.
const profile = await loadProfile(pool, cfg.appId);   // :47 — one DB read, the me.md text
...
const agent = new RagQueryAgent({ model, tools, profile, trace });  // :57 — profile handed in
```

Annotation: `profile` is a plain string. It is fetched before any turn runs and never re-read.
If the user updates their me.md mid-session, this session will not see it — that's the cost of
treating it as canonical-local, and it's the right cost for a profile that changes monthly, not
per turn.

### The profile becomes standing context: prepended to the system prompt

This is the actual context-engineering move. `injectProfile` (`@aptkit/context`) takes the
profile text and the instruction template and glues the profile *on top*, under a fixed heading,
so it leads every system prompt the model ever sees.

```ts
// @aptkit/context — profile-injector.ts:25-38 — pure string-in / string-out.
export function injectProfile(systemTemplate, profileText, opts): string {
  const position = opts?.position ?? 'start';            // default: PREPEND
  const block = heading ? `${heading}\n${profileText}` : profileText;
  return position === 'end'
    ? `${systemTemplate}\n\n${block}`
    : `${block}\n\n${systemTemplate}`;                    // ← profile FIRST, then instructions
}
```

```ts
// @aptkit/agents/rag-query — rag-query-agent.ts:52-59 — done ONCE, in the constructor.
constructor(private readonly options: RagQueryAgentOptions) {
  const template = options.prompt ?? DEFAULT_SYSTEM_TEMPLATE;
  const withProfile = options.profile
    ? injectProfile(template, options.profile, {
        position: 'start',                                 // profile leads
        heading: '# About the person you are assisting',   // fixed heading (PROFILE_HEADING)
      })
    : template;
  this.system = renderPromptTemplate(withProfile, {});     // freeze it: this.system never changes
}
```

```
  injectProfile — the profile becomes the head of every system prompt

  profileText ──┐
                ├─▶ injectProfile(position:'start') ─▶ this.system (frozen)
  template    ──┘
                                                          │
   "# About the person you are assisting"                 │ read on EVERY model.complete()
   <profile text>                                         ▼
                                              ┌────────────────────────┐
   <instructions: always search first...>    │ the standing context   │
                                              └────────────────────────┘
```

Annotation: `injectProfile` never touches `fs` — the session reads the file, the injector only
splices strings. And it runs *before* `renderPromptTemplate`, so the result is still a valid
template (placeholders like `{schema}` survive). The key fact: `this.system` is computed once in
the constructor and reused for every `answer()`. The profile is standing context in the most
literal sense — it stands still while everything else moves.

### The guard caps the whole window

The profile is constant, but the messages array and tool outputs grow per turn. Left unbounded,
a few searches of fat pgvector hits overflow the model's context and it starts dropping the
*earliest* tokens — which is the profile. Bridge from frontend: this is the loading-state
guard around a `fetch()` that could return 10MB. You cap it before it breaks the render.

```ts
// src/session.ts:46 — wrap Gemma so the assembled context can't overflow.
const model = new ContextWindowGuardedProvider(
  new GemmaModelProvider({ host: cfg.ollamaHost }),
  { maxTokens: 8192 },   // ← the ceiling on profile + messages + tool outputs, combined
);
```

```
  ContextWindowGuardedProvider — the ceiling on the assembled window

  profile + instructions  ─┐
  messages array          ─┼─▶ [ guard: total <= 8192 tokens ] ─▶ Gemma
  tool outputs            ─┘            │
                                        └─ over budget? the guard intervenes
                                           BEFORE the model silently drops the profile
```

Annotation: the guard wraps the provider, so the loop never knows it's there — it just calls
`model.complete()` as usual. The number `8192` is buffr's whole context budget. Every token the
profile spends is a token a tool output cannot. That tension is the engineering: a longer
profile is more standing context but less room to retrieve.

### Move 3 — the principle

**The model is a pure function of its context window; engineering the agent is engineering that
window.** You control one layer fully (the standing system prompt) and bound the rest (the
guard). When an agent gives a bad answer, the staff-engineer reflex is not "swap the model" — it
is "show me the exact context that call saw." Nine times in ten the profile got pushed out, the
wrong chunks got retrieved, or the window overflowed. Those are context failures, and they are
yours to fix.

## Primary diagram

Full recap: the four sources, who writes each, and the single guard over the sum.

```
  buffr's context window — assembly + guard (session.ts:46-57, rag-query-agent.ts:52-59)

  CONSTRUCTION TIME (engineer controls)
  ┌────────────────────────────────────────────────────────────────┐
  │ loadProfile (session.ts:47) ─▶ injectProfile (profile-injector  │
  │   :25-38, position:'start') ─▶ renderPromptTemplate             │
  │   ─▶ this.system  (rag-query-agent.ts:52-59, FROZEN)           │
  └────────────────────────────────────────────────────────────────┘
                              │ this.system reused every turn
  RUN TIME (loop + tools control)
  ┌────────────────────────────────────────────────────────────────┐
  │ messages array (run-agent-loop.ts:94,124,189) — grows per turn  │
  │ tool outputs   (pgvector hits, fed back as user msgs)           │
  └────────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌────────────────────────────────────────────────────────────────┐
  │ ContextWindowGuardedProvider · maxTokens:8192 (session.ts:46)   │
  │   the ONE ceiling over profile + messages + tool outputs        │
  └────────────────────────────────────────────────────────────────┘
```

The profile is constant, the rest grows, the guard caps the sum. That is the entire context
engineering story for a single agent.

## Elaborate

profile-as-standing-context is the simplest, most durable form of context engineering: a fact
the agent should *always* know goes in the system prompt, not in a tool the model has to
remember to call. Compare it to memory (file 02): the profile is recalled *unconditionally*
every turn, whereas episodic memory is recalled *by relevance* only when it matches. That's a
deliberate split — identity facts ("this person is a frontend engineer moving into AI") should
never depend on a similarity score, so they live in standing context, not memory.

The multi-agent shape of this discipline is *shared-context routing*: when five agents
collaborate, the question becomes which agent sees which slice of context, and stale or
over-broad context becomes a correctness bug. buffr is single-agent, so its context engineering
is just the system prompt plus the guard — no routing, no per-agent slicing. That simplicity is
correct for one agent over one store; name it as a deliberate scope, not a missing feature.

Cross-ref `study-ai-engineering` for the mechanics this file assumes: the context-window limit
and the *lost-in-the-middle* effect (why the profile goes at the `start`, the most-attended
position, and not buried in the middle). This file covers only the assembly-and-guard angle.

## Interview defense

**Q: "Your agent gave a wrong answer. The model or the context?"**

Model answer: "Almost always the context, and I can prove which part. buffr's context window is
four things: the profile and instructions (the frozen system prompt, `rag-query-agent.ts:52-59`),
the growing messages array, and the tool outputs (`run-agent-loop.ts:94,124,189`). The profile
is standing context — prepended once at construction by `injectProfile`
(`profile-injector.ts:25-38`) under a fixed heading, read on every call, never re-fetched. The
guard, `ContextWindowGuardedProvider` at `maxTokens:8192` (`session.ts:46`), caps the sum so a
fat retrieval can't silently push the profile out of the window. So when an answer is wrong I
replay the exact context that call saw — usually it's the wrong chunks retrieved or the window
overflowing, not the model. Most agent failures are context failures."

```
  The defense in one picture

  bad answer  ──▶  replay the EXACT context that call saw
                     │
        ┌────────────┼─────────────┐
        ▼            ▼             ▼
   profile        wrong         window
   dropped?       chunks?       overflow?
        └──── all CONTEXT failures, all fixable by you ────┘
```

Anchor: *Four sources — profile + instructions (frozen), messages array, tool outputs — capped
by one guard at 8192; agent failures are context failures, not model failures.*

## See also

- `02-agent-memory-tiers.md` — the profile (unconditional recall) vs episodic memory
  (relevance recall); two ways context enters the window.
- `03-tool-calling-and-mcp.md` — tool outputs are the per-call layer of the context window.
- `05-guardrails-and-control.md` — the guard here is one of buffr's bounds; that file collects
  them all.
- `study-ai-engineering` → context-window limits and lost-in-the-middle (why profile leads).
- `../01-reasoning-patterns/02-agent-loop-skeleton.md` — where the messages array is appended.
