# 05 — Profile Injection as Context

**Industry name(s):** Profile injection / persona-as-system-context / context augmentation
of the system prompt.
**Type:** Industry standard (context engineering), project-specific source (`me.md` as a row).

## Zoom out, then zoom in

Here's the whole system, with one small but identity-defining box lit. Before any turn,
the session reads a profile — the `me.md`-style model of the user — out of Postgres and
hands it to the agent, which injects it into the system prompt. That single string is
what turns "a RAG box" into "*your* assistant."

```
  Zoom out — where the profile enters

  ┌─ Storage layer ─────────────────────────────────────────────────────┐
  │  agents.profiles (content = the me.md-style profile text)            │
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │ loadProfile(pool, appId)
  ┌─ Session layer ───────────────▼──────────────────────────────────────┐
  │  profile = await loadProfile(...)  (src/session.ts:47)               │ ← we are here
  │  new RagQueryAgent({ ..., profile })                                  │
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │ injected into the system prompt (aptkit)
  ┌─ Provider layer ──────────────▼──────────────────────────────────────┐
  │  Gemma sees: [profile] + [base system rules] + [user question]       │
  └───────────────────────────────────────────────────────────────────────┘
```

Zoom in. The pattern is **context injection**: pull a piece of durable state and weave it
into the model's system prompt so every generation is shaped by it. The question it
answers: *how do you make one agent speak in the user's voice and know who it's helping,
without retraining anything and without the user restating themselves every turn?*

## Structure pass

**Layers:** storage (`profiles` table) → loader (`loadProfile`) → session (passes
`profile` to the agent) → aptkit (injects it before the base system prompt) → model.

**Axis — state ownership and freshness.** Trace it. The profile *lives* in Postgres
(durable, editable as a row). It's *loaded once per session* (`src/session.ts:47`) — not
per turn — so within a session it's a constant. The model sees it on *every* turn because
it's baked into the system prompt the agent was built with. Ownership: Postgres owns the
truth; the session owns the per-run snapshot; the model owns nothing, it just reads.

**Seam:** the agent's `profile` constructor field (`src/session.ts:57`). A horizontal
seam — buffr promises a string; aptkit promises to place it in the system prompt. buffr
doesn't know *where* in the prompt; aptkit doesn't know the string came from Postgres.

## How it works

### Move 1 — the mental model

You've passed a `theme` or a `locale` down through context so every component renders the
user's way without each one asking for it. Profile injection is that, one level up: the
profile is the "theme" for the *model's* output — set it once at the top, every
generation inherits it. The strategy: **prepend durable user-context to the system prompt
so it conditions every response.**

```
  the injection shape — profile conditions every turn

   agents.profiles.content ──► loadProfile ──► agent.profile
                                                   │ injected once
                                                   ▼
   system prompt = [ PROFILE ] + [ base rules ]   ──► every Gemma turn reads it
```

### Move 2 — the walkthrough

**The loader — pure and minimal.** `loadProfile` reads the most-recent profile row for an
app, returning `''` if none exists (`src/profile.ts:4-8`):

```ts
// src/profile.ts:4-8 — newest profile for this app_id, or empty string
export async function loadProfile(pool: pg.Pool, appId: string): Promise<string> {
  const { rows } = await pool.query(
    'select content from agents.profiles where app_id = $1 order by updated_at desc limit 1',
    [appId]);
  return rows[0]?.content ?? '';
}
```

What breaks without the `?? ''` fallback: a fresh database with no profile row would hand
`undefined` to the agent, and the system-prompt assembly downstream would render
`"undefined"` into Gemma's context. The empty-string default makes "no profile" a clean
no-op rather than a corrupted prompt. This is the load-bearing edge case.

**Load once, at session build.** The profile is loaded during `createChatSession` and
passed into the agent constructor (`src/session.ts:47`, `:57`):

```ts
// src/session.ts:47,57 — snapshot the profile once, bake it into the agent
const profile = await loadProfile(pool, cfg.appId);
// ...
const agent = new RagQueryAgent({ model, tools, profile, trace });
```

Because it's loaded once and baked into the agent, editing the `profiles` row mid-session
has no effect until the next `chat` run — the freshness boundary is the session, not the
turn. For a single user editing their own profile occasionally, that's the right
granularity; re-reading per turn would be wasted work.

**Injection happens in aptkit.** The actual placement — prepend the profile, then the
base system rules — is aptkit's `injectProfile` (the C package from
`docs/superpowers/plans/2026-06-19-laptop-build.md`, Task 10). It's a pure
string-in/string-out function: `injectProfile(systemTemplate, profileText)` returns
`[profile block] + [system template]`. buffr doesn't own that placement logic — it owns
*sourcing* the profile from Postgres and *handing it over*. That split is the
library-as-dependency-boundary again (file 02): buffr provides the deployment-specific
data, aptkit provides the reusable logic.

```
  Layers-and-hops — profile from row to model

  ┌─ Postgres ──┐ hop 1: SELECT content    ┌─ session ──┐
  │ profiles    │ ────────────────────────► │ loadProfile│ hop 2: profile string
  └─────────────┘                           └─────┬──────┘ ─────────────────────┐
                                                  │ baked into agent             │
                                          ┌───────▼────────┐            ┌────────▼────────┐
                                          │ RagQueryAgent  │ hop 3:     │ aptkit          │
                                          │  profile field │ injectProfile│ [profile]+[base]│
                                          └────────────────┘ ──────────►└────────┬────────┘
                                                                          hop 4: system prompt
                                                                                 ▼
                                                                          ┌─ Gemma ─┐
                                                                          └─────────┘
```

### Move 3 — the principle

The cheapest way to personalize a model is to condition it, not retrain it. Durable
user-context belongs at the top of the system prompt where it shapes every generation;
the source of that context (a Postgres row, a file, an API) is incidental, the injection
point is what matters. Here it's the seam that makes the agent *yours*: the same Gemma
weights, the same loop, but every answer reads who it's helping first.

## Primary diagram

The full path, from durable row to conditioned generation, every layer.

```
  profile injection — me.md as live context

  ┌─ Storage: agents.profiles ──────────────────────────────────────────┐
  │  content (the me.md-style profile)   ·  keyed by app_id              │
  └───────────────────────────────┬──────────────────────────────────────┘
                  loadProfile (newest, or '')   src/profile.ts
  ┌─ Session ─────────────────────▼──────────────────────────────────────┐
  │  profile snapshot (once per run) → RagQueryAgent({ profile })         │
  └───────────────────────────────┬──────────────────────────────────────┘
                  injectProfile (aptkit, pure)  → [profile] + [base rules]
  ┌─ Provider: Gemma ─────────────▼──────────────────────────────────────┐
  │  every turn's system prompt leads with who it's helping              │
  └───────────────────────────────────────────────────────────────────────┘
```

## Elaborate

This is context engineering — the discipline of deciding what goes into the model's
window and where. Profile injection is the persona slice of it: persistent
memory-of-you, the Hermes "owns a model of you" layer
(`docs/superpowers/specs/2026-06-19-aptkit-packages-design.md:33`), realized as a system-
prompt prepend. The intent is explicit: turn "a RAG box" into "*your* assistant"
(`...aptkit-packages-design.md:256`). It pairs with retrieval-as-memory (file 06) —
profile is *who you are* (static persona), memory is *what we said* (dynamic episodic
recall); together they're the two halves of "knows you." Prompt-construction mechanics
(token budget, ordering, prompt templates) belong to `study-prompt-engineering`; this
file owns the architectural seam — where the profile is sourced and injected.

What to read next: `06-retrieval-as-memory.md` (the dynamic half of "knows you"),
`02-library-as-dependency-boundary.md` (why injection logic is aptkit's, sourcing is
buffr's).

## Interview defense

**Q: Why inject the profile into the system prompt instead of fine-tuning the model on
the user's voice?**
Cost and reversibility. Conditioning via the system prompt is free, instant, and
editable — change the `profiles` row, restart, done. Fine-tuning is the ceiling, gated on
Phase-4 evidence (`agent-layer-plan.md:19`), and welds the persona into weights you can't
easily edit. Injection gets 90% of the personalization at 0% of the training cost.

```
  inject  ─► edit a row, restart        (free, reversible)
  fine-tune ─► retrain on persona data  (the ceiling, gated)
```
Anchor: `src/session.ts:47` loads the profile; aptkit `injectProfile` places it.

**Q: What's the edge case people forget here?**
The empty profile. A fresh DB has no profile row; `loadProfile` returns `''` not
`undefined`, so "no profile" is a clean no-op instead of rendering `"undefined"` into
Gemma's context.
Anchor: the `?? ''` fallback at `src/profile.ts:8`.

**Q: When does an edited profile take effect?**
Next session, not next turn — it's snapshotted once at `createChatSession`. For a single
user editing occasionally, session-granularity freshness is right; per-turn re-reads
would be wasted work.
Anchor: load-once at `src/session.ts:47`, baked into the agent at `:57`.

## See also

- `06-retrieval-as-memory.md` — the dynamic, episodic half of "knows you"
- `04-long-lived-chat-session.md` — where the profile is loaded once at build
- `02-library-as-dependency-boundary.md` — injection logic in aptkit, sourcing in buffr
- `study-prompt-engineering` — system-prompt construction, token budget, ordering
