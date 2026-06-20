# Profile Injection as Context

**Industry names:** system-prompt injection · persona/context grounding ·
me.md-as-a-row · Project-specific (the profile is a DB row, not a constant)

## Zoom out, then zoom in

The agent answers in a *voice* — it knows who the user is, because a profile
(a me.md-style document) is read from `agents.profiles` and injected into the
system prompt at run time. The profile isn't hardcoded; it's a row, so it can
change without a code change, and it's keyed by `app_id` so a future second
app gets its own voice. This is the smallest, quietest of buffr's adapters —
one `select`, one injected string — but it's what makes the answer *the user's
agent* rather than a generic Gemma.

```
  Zoom out — where the profile enters the agent

  ┌─ CLI layer (buffr) ──────────────────────────────────────────┐
  │  ask-cmd: profile = await loadProfile(pool, appId)            │
  └──────────────────────────┬───────────────────────────────────┘
  ┌─ Adapter layer (buffr) ──▼──────────────────────────────────┐
  │      ★ loadProfile ★   SELECT content ... ORDER BY updated_at │
  └──────────────────────────┬───────────────────────────────────┘
                             │ string
  ┌─ Toolkit layer (aptkit) ──▼──────────────────────────────────┐
  │  new RagQueryAgent({ ..., profile }) → injected into system   │
  │  prompt → grounds every generated answer                      │
  └───────────────────────────────────────────────────────────────┘
  ┌─ Storage ─────────────────────────────────────────────────────┐
  │  agents.profiles(app_id, content, updated_at)                  │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **context grounding via system-prompt injection**,
with the twist that the context is *persisted and versioned-by-recency*, not
compiled in. Strip it and the agent loses its persona — it answers correctly
from the corpus but in a generic voice, with no notion of who's asking.

## Structure pass

**Layers** — CLI → `loadProfile` adapter → agent (aptkit) → prompt → model.

**Axis: where does the persona live, and how mutable is it?** Trace it.

```
  One question: "where does the agent's voice come from?"

  ┌──────────────────────────────────────────────┐
  │ alternative: hardcoded string constant         │ → compiled in, immutable
  └───────────────────────┬──────────────────────┘
      ┌───────────────────▼──────────────────────┐
      │ buffr: agents.profiles row (latest wins)  │ → DATA, mutable per app
      └───────────────────┬──────────────────────┘
          ┌───────────────▼──────────────────────┐
          │ injected: into the system prompt      │ → runtime, per invocation
          └───────────────────────────────────────┘

  the persona moves from CODE to DATA — that's the design choice
```

**Seam.** Two seams. Horizontal: `loadProfile` is the boundary between "a row
in Postgres" and "a string the agent accepts" — the same adapter shape as the
vector store, just degenerate (one read, no write). Vertical: the `profile`
field on `RagQueryAgent`'s options is the contract aptkit exposes for
injecting persona — buffr fills it. The property that flips: in the DB the
profile is *queryable data*; once injected it's *prompt context the model
can't see as separate from instructions*.

## How it works

### Move 1 — the mental model

You know how you pass `props` to a component to configure it per render, rather
than baking values into the component? The profile is a prop for the agent's
voice — fetched fresh each run, injected, gone when the process exits.

```
  context injection — fetch, inject, ground

  agents.profiles ─► loadProfile ─► "I'm Rein, a SWE3..." (string)
                                          │
                                          ▼  RagQueryAgent({ profile })
                            system prompt = [persona] + [instructions]
                                          │
                                          ▼
                        every answer is grounded in that persona
```

### Move 2 — the load-bearing skeleton

Three parts. Each named by what breaks without it.

#### Part 1 — latest-wins selection

`loadProfile` doesn't read *a* profile — it reads the *most recent* one,
`order by updated_at desc limit 1`, scoped to `app_id`. That ordering is the
versioning scheme: update the profile by inserting a newer row, and the next
`ask` picks it up.

```
  pseudocode — latest-wins

  SELECT content FROM agents.profiles
   WHERE app_id = $1
   ORDER BY updated_at DESC          // newest first
   LIMIT 1                           // just the current one
  return rows[0].content ?? ''       // empty string if none
```

What breaks without `order by updated_at desc`: you'd get an arbitrary
profile row, so "updating" the persona by inserting a new row would do nothing
predictable. The recency order *is* the update mechanism.

#### Part 2 — the empty-string fallback

If no profile row exists, `loadProfile` returns `''`, not `null` or undefined.
The agent gets a valid (empty) persona and still answers — just generically.

```
  the fallback — degrade, don't crash

  rows[0]?.content ?? ''
       │
       └─ no profile? → '' → agent runs with no persona, answers anyway.
          A null here could throw inside prompt assembly. Empty string is the
          safe identity element for string concatenation into the prompt.
```

What breaks without the `?? ''`: a fresh DB with no profile row would feed
`undefined` into the prompt builder — a crash or a literal "undefined" in the
system prompt, instead of graceful generic behavior.

#### Part 3 — app_id scoping (the multi-tenant hook)

The query filters by `app_id`. Today there's one (`'laptop'`), so the filter
is a no-op in practice — but it's the seam where a future second app
(`blooming`, `contrl`) gets its *own* profile from the same table.

```
  app_id scope — one table, per-app personas (future)

  agents.profiles
    app_id='laptop'   → laptop's me.md        ◄── today, the only one
    app_id='blooming' → blooming's persona    ◄── deferred, no migration needed
       │
       └─ loadProfile(pool, cfg.appId) selects the right one. The column is
          cheap now, painful to retrofit — same forward-compat logic as the
          rest of the schema.
```

### Move 3 — the principle

Persona is *data*, not code. The moment the agent's voice lives in a row
instead of a string literal, you can change it without a deploy, version it by
recency, and partition it by tenant — all without touching the agent. The cost
is one extra read per run; the benefit is that "who is this agent" becomes an
editable fact, not a code change.

## Primary diagram

The full injection path, latest-wins and fallback marked.

```
  Profile injection — full path

  ┌─ Storage ─────────────────────────────────────────────────────┐
  │ agents.profiles(app_id, content, updated_at)                   │
  │   many rows possible → ORDER BY updated_at DESC LIMIT 1        │
  └───────────────────────┬────────────────────────────────────────┘
                          │ loadProfile(pool, appId)
  ┌─ Adapter (buffr) ─────▼────────────────────────────────────────┐
  │ rows[0]?.content ?? ''   ← latest-wins + empty fallback         │
  └───────────────────────┬────────────────────────────────────────┘
                          │ string
  ┌─ CLI (ask-cmd) ───────▼────────────────────────────────────────┐
  │ const profile = await loadProfile(pool, cfg.appId)             │
  │ new RagQueryAgent({ model, tools, profile, trace })            │
  └───────────────────────┬────────────────────────────────────────┘
                          │ profile injected
  ┌─ Agent (aptkit) ──────▼────────────────────────────────────────┐
  │ system prompt = persona + instructions → grounds every answer  │
  └─────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Read once per `ask`, right before the agent is built. It's the
"who am I answering as" step. There's no write path in the repo — profile rows
are inserted out of band (the design calls it "me.md as a row").

**The whole adapter — eight lines** — `src/profile.ts:1-9`

```
  export async function loadProfile(pool: pg.Pool, appId: string): Promise<string> {
    const { rows } = await pool.query(
      'select content from agents.profiles where app_id = $1 order by updated_at desc limit 1', ← latest-wins, app-scoped
      [appId]);
    return rows[0]?.content ?? '';        ← empty-string fallback
  }
        │
        └─ the entire pattern in one query: app_id filter (tenant), updated_at
           desc + limit 1 (versioning), ?? '' (graceful no-profile). No write
           side — read-only by design this phase.
```

**Where it's injected** — `src/cli/ask-cmd.ts:27, 33`

```
  const profile = await loadProfile(pool, cfg.appId);              ← 27: fetch
  ...
  const agent = new RagQueryAgent({ model, tools, profile, trace });← 33: inject
        │
        └─ profile is a constructor option on aptkit's RagQueryAgent — buffr
           fills the persona slot the toolkit exposes. The agent assembles it
           into the system prompt (aptkit's job, not buffr's).
```

**The table it reads** — `sql/001_agents_schema.sql:52-58`

```
  create table if not exists agents.profiles (
    id uuid primary key default gen_random_uuid(),
    app_id text not null default 'laptop',     ← the tenant key loadProfile filters on
    user_id text,                              ← forward-compat, unused this phase
    content text not null,                     ← the me.md text
    updated_at timestamptz not null default now()  ← the latest-wins sort key
  );
        │
        └─ updated_at is what makes ORDER BY ... DESC LIMIT 1 a versioning
           scheme; app_id is what makes the table multi-tenant-ready.
```

## Elaborate

System-prompt grounding is the standard way to give an LLM stable context it
should treat as background truth rather than per-turn instruction — persona,
domain facts, formatting rules. Making that context a *database row* instead
of a constant is the meaningful design move: it's the difference between a
persona you redeploy to change and one you edit like content. The name "me.md
as a row" is literal — the reader's whole study family runs on a `me.md`
reader-profile document; buffr persists that same idea as agent context. The
forward-compat columns (`app_id`, `user_id`) follow the schema's overall
philosophy: cheap to add now, painful to retrofit (`agent-layer-plan.md` open
questions). Prompt-construction details (how persona and retrieved context are
ordered in the final prompt, token budget) belong to `study-prompt-engineering`
and `study-ai-engineering`; the *injection seam* is what lives here.

## Interview defense

**Q: Why is the profile a DB row instead of a hardcoded system-prompt string?**

So persona becomes editable data, not a code change — you update the voice by
inserting a row, version it by recency (`order by updated_at desc limit 1`),
and partition it per app via `app_id`. The cost is one read per run; the
benefit is the agent's identity is a fact you can change without a deploy.

```
  hardcoded string → redeploy to change persona
  agents.profiles row → insert a row, next ask picks it up
```

Anchor: `src/profile.ts:6`.

**Q: Fresh database, no profile row. What does the agent do?**

It answers, generically. `loadProfile` returns `''` via `rows[0]?.content ??
''`, so the agent gets a valid empty persona and runs — no crash. The
empty-string (not null) fallback is the load-bearing detail: it's the identity
element for string concatenation into the prompt.

```
  no row → '' → agent runs (generic voice)
  no fallback → undefined → prompt-build crash or literal "undefined"
```

Anchor: `src/profile.ts:8`.

## Validate

1. **Reconstruct.** Write the `loadProfile` query from memory, including the
   three load-bearing pieces (app_id filter, latest-wins sort, fallback).
2. **Explain.** Why `order by updated_at desc limit 1` instead of just
   selecting any row? (`profile.ts:6`.)
3. **Apply.** You want a second app's agent to answer in a different voice.
   What changes in the code vs in the data? (Data: insert a row with the new
   `app_id`. Code: nothing — `loadProfile(pool, cfg.appId)` already scopes.)
4. **Defend.** Argue for returning `''` rather than throwing when no profile
   exists (`profile.ts:8`).

## See also

- `03-trajectory-capture.md` — the other thing injected into the agent
  (the trace sink).
- `04-library-as-dependency-boundary.md` — `profile` is an aptkit option buffr
  fills.
- `05-cli-as-entrypoints.md` — where `loadProfile` runs in the `ask` flow.
- `study-prompt-engineering` — how persona is assembled into the prompt.
- `study-data-modeling` — the `profiles` table shape and `app_id` scoping.
