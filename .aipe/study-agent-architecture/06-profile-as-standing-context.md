# Profile as standing context (me.md injected into the system prompt)

**Industry name(s):** Standing context / persona injection / system-prompt
context engineering · *Industry standard*

---

## Zoom out, then zoom in

The agent answers as a *personal* knowledge assistant. What makes it personal is
a profile document — an `me.md`-style description of the user — that's loaded
from the database and stitched onto the front of the system prompt before every
run. It's context the model always sees, independent of what it retrieves.

```
  Zoom out — where the profile enters the prompt

  ┌─ Storage ─────────────────────────────────────────────────┐
  │  agents.profiles (most-recent row for app_id)             │
  └───────────────────────────────┬───────────────────────────┘
                                  │ loadProfile()
  ┌─ Agent construction (aptkit) ─▼───────────────────────────┐
  │  RagQueryAgent ctor:                                      │
  │   ★ injectProfile(template, profile, position:'start') ★  │ ← we are here
  │   → system prompt = profile + RAG instructions            │
  └───────────────────────────────┬───────────────────────────┘
                                  │ every model.complete carries it
  ┌─ Agent loop ──────────────────▼───────────────────────────┐
  │  Gemma sees the profile on EVERY turn                     │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: this is context engineering in its simplest, most durable form — not
retrieved per-query, not in the conversation history, but baked into the system
prompt at agent-construction time so it's present on every single turn. It sits
*above* the prompt and *above* retrieval in the context hierarchy: it's the
standing frame everything else fills in.

---

## Structure pass

**Axis: lifecycle — when does each piece of context get assembled?**

```
  "when is this context assembled?" — traced by lifecycle

  ┌──────────────────────────────────────────────┐
  │ profile: at agent CONSTRUCTION (once/session) │  → standing, every turn
  └──────────────────────────────────────────────┘
      ┌──────────────────────────────────────────┐
      │ retrieved chunks: per TOOL CALL (≤4×)     │  → dynamic, some turns
      └──────────────────────────────────────────┘
          ┌──────────────────────────────────────┐
          │ user question: at run START (once)     │  → the prompt
          └──────────────────────────────────────┘
```

**The seam:** the boundary between *standing* context (assembled once, present
always) and *dynamic* context (retrieved per turn). The profile is on the
standing side; chunks are on the dynamic side. That split is the core idea of
context engineering — deciding what's always-loaded vs what's fetched-on-demand.
Get it wrong (profile retrieved per query, or chunks jammed into the system
prompt) and you either lose personalization or bloat the window.

---

## How it works

### Move 1 — the mental model

You know how a React context provider wraps the whole tree so every component
can read the current user without prop-drilling? The profile is that for the
agent: injected once at the top, readable on every turn, no plumbing per turn.

```
  The pattern — inject once, present everywhere

  profile text ──┐
                 ▼
  template ──► injectProfile(start) ──► system prompt ──┐
                                                        │ (frozen for the run)
  turn 0 ─┐ turn 1 ─┐ turn 2 ─┐  ... each model.complete │
          └─────────┴─────────┴──────────────────────────┘
                  all carry the same system prompt = profile + instructions
```

### Move 2 — the mechanism, part by part

**Load the profile from the DB.** `loadProfile` reads the most-recent profile
row for the app id. If there's none, it returns `''` — a clean no-op, the agent
just isn't personalized. Bridge: it's a `SELECT ... ORDER BY updated_at DESC
LIMIT 1`, the same "latest row wins" pattern you'd use for any single-value
config lookup.

```
  loadProfile(pool, appId):
    row = SELECT content FROM agents.profiles
          WHERE app_id = appId ORDER BY updated_at DESC LIMIT 1
    return row?.content ?? ''     // empty string = unpersonalized, not an error
```

What breaks without the `?? ''`: a missing profile would inject `undefined` into
the prompt or throw. The empty-string default makes "no profile" a valid state.

**Inject before template rendering, at the start.** `injectProfile` prepends the
profile (under a heading) to the system template — *before* placeholders like
`{schema}` are resolved — so the result is still a valid template the renderer
can process. Position `'start'` puts the persona first, framing everything that
follows.

```
  injectProfile(template, profile, {position:'start', heading:'# About the person...'}):
    block = heading + '\n' + profile
    return block + '\n\n' + template     // profile leads, instructions follow
```

What breaks if you inject *after* rendering: any `{placeholder}` inside the
profile text would get mangled, and the order (`inject` then `render`) is
exactly what keeps the profile a passive block while the template stays
renderable. The ordering comment in the code is load-bearing.

**It's frozen for the run.** The constructor computes `this.system` once; every
`model.complete` reuses it (`01-bounded-react-loop.md`). So the profile is on
every turn at zero per-turn cost — it's part of the prompt prefix.

```
  Layers-and-hops — profile from DB to every turn

  ┌─ DB ─────────┐ loadProfile  ┌─ session.ts ─┐ profile  ┌─ RagQueryAgent ─┐
  │ agents.      │ ───────────► │ pass to ctor │ ───────► │ injectProfile   │
  │ profiles     │              └──────────────┘          │ → this.system   │
  └──────────────┘                                        └────────┬────────┘
                                          this.system (frozen)     │
                                                                   ▼
                                                  every model.complete() turn
```

### Move 3 — the principle

Context engineering is deciding *what fills the window for every step* — and the
cheapest, most reliable slot is the system-prompt prefix. Standing context
(persona, role, durable preferences) belongs there: assembled once, present
always, cached as a prefix. Dynamic context (retrieved evidence) belongs in the
loop. The discipline is keeping those two separate — the profile is the
textbook case of getting standing context into the prefix and leaving the window
free for what retrieval brings back.

---

## Primary diagram

```
  Profile-as-context in buffr — full recap

  ┌─ session.ts:47 ───────────────────────────────────────────┐
  │ profile = await loadProfile(pool, appId)   ← latest row    │
  └───────────────────────────────┬───────────────────────────┘
                                  │ new RagQueryAgent({ ..., profile })
  ┌─ RagQueryAgent ctor (rag-query-agent.js:25-32) ───────────┐
  │ template = DEFAULT_SYSTEM_TEMPLATE  ("personal knowledge   │
  │            assistant. Always call search first. Cite...")  │
  │ withProfile = injectProfile(template, profile,            │
  │               { position:'start', heading:PROFILE_HEADING})│
  │ this.system = renderPromptTemplate(withProfile, {})        │
  └───────────────────────────────┬───────────────────────────┘
                                  ▼  (frozen for the whole run)
  ┌─ every loop turn ─────────────────────────────────────────┐
  │ model.complete({ system: this.system, messages, tools })   │
  │   Gemma sees: # About the person... <profile>              │
  │              + "personal knowledge assistant..." + chunks  │
  └────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

### Use cases

Reached once per chat session, at agent construction (the session builds the
agent once and reuses it for every turn — `session.ts:47, 57`). It's what lets
the same corpus and the same model answer *as the user's* assistant — grounding tone and
relevance to the person in `agents.profiles`. With no profile row, the agent
degrades gracefully to a generic knowledge assistant (empty-string injection).

### Code, side by side

The load (`src/profile.ts:4-8`):

```
export async function loadProfile(pool, appId): Promise<string> {
  const { rows } = await pool.query(
    'select content from agents.profiles where app_id = $1 ' +
    'order by updated_at desc limit 1', [appId]);    ← latest profile wins
  return rows[0]?.content ?? '';                     ← no profile → '' (graceful)
}
```

The injection (`@aptkit/agent-rag-query/dist/src/rag-query-agent.js:25-32`):

```
constructor(options) {
  const template = options.prompt ?? DEFAULT_SYSTEM_TEMPLATE;
  const withProfile = options.profile
    ? injectProfile(template, options.profile,
        { position: 'start', heading: PROFILE_HEADING })  ← profile leads the prompt
    : template;                                           ← no profile → bare template
  this.system = renderPromptTemplate(withProfile, {});    ← render AFTER inject
}
       │
       └─ inject-then-render order is deliberate: placeholders in the template
          survive, and the profile stays a passive block (injector comment,
          profile-injector.js:8-13).
```

The wiring (`src/session.ts:47, 57`):

```
const profile = await loadProfile(pool, cfg.appId);
...
const agent = new RagQueryAgent({ model, tools, profile, trace });
       │
       └─ buffr's only job here: fetch the row, hand it to the agent.
          The injection mechanics are aptkit's.
```

---

## Elaborate

The spec frames context engineering as the superset that prompt engineering,
RAG, memory, tool outputs, and user profile are all subsets of. buffr exercises
two of those slots concretely: **user profile** (this file) and **tool outputs /
RAG** (`03-agentic-retrieval.md`). The reframe worth carrying: most agent
failures are context failures, not model failures — and the profile is the slot
that prevents the "no user state loaded" failure. It's also a free
prompt-prefix-cache win: because the profile + instructions are stable across
every turn, a provider that caches prefixes reuses them turn-to-turn (Gemma via
Ollama doesn't expose this today, but the structure is cache-ready).

The injection *seam* — the inject-before-render ordering, the pure string-in/
string-out contract — is walked as a system-design concern in
`.aipe/study-system-design/06-profile-injection-as-context.md`. This file owns
the *context-engineering* framing: profile as standing context vs retrieved
chunks as dynamic context.

---

## Interview defense

**Q: How does the agent know who it's talking to?**
A profile document is loaded from the database and injected at the front of the system prompt at construction time, so it's present on every turn. It's standing context — assembled once, always loaded — distinct from the chunks retrieval brings back per query.

```
  standing (profile): in the prefix, every turn
  dynamic (chunks):   in the loop, some turns
```
Anchor: "Standing context goes in the prefix; dynamic context goes in the loop."

**Q: Why inject before rendering the template?**
So template placeholders survive. If you injected after rendering, any `{placeholder}` in the profile text would get mangled, and the profile wouldn't compose cleanly with the template. Inject-then-render keeps the profile a passive block and the template renderable.
Anchor: "Inject then render — order keeps both halves valid."

---

## Validate

1. **Reconstruct:** Draw where the profile enters the prompt and on how many
   turns it's present. (`rag-query-agent.js:25-32`; every turn — it's frozen.)
2. **Explain:** Why does `loadProfile` return `''` rather than throw on a
   missing profile? (`src/profile.ts:7`.)
3. **Apply:** A profile contains the text `{schema}`. With inject-before-render,
   what happens to it? (Left untouched — `renderPromptTemplate` only resolves
   known keys; `profile-injector.js:8-13`.)
4. **Defend:** Argue why the profile belongs in the system prefix rather than
   being retrieved per query like corpus chunks. (Standing vs dynamic context.)

---

## See also

- `01-bounded-react-loop.md` — the system prompt this builds is reused every turn
- `03-agentic-retrieval.md` — the dynamic context that complements the profile
- `audit.md` — Lens 7 (context engineering)
- `.aipe/study-system-design/06-profile-injection-as-context.md` — the injection seam
- Context window / lost-in-the-middle (sibling generator): `.aipe/study-ai-engineering/02-llm-foundations/`

---

Updated: 2026-06-24 — Injection pattern unchanged; re-pointed profile-load/wiring
refs from the deleted `ask-cmd.ts` to `src/session.ts:47, 57`. Profile is now
loaded once per long-lived chat session (agent built once, reused every turn),
rather than once per one-shot `ask` invocation.
