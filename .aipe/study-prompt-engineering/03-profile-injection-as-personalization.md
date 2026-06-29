# Profile injection as personalization

*System-prompt personalization / persona injection — Industry standard (the
"prepend a user profile to the system prompt" pattern).*

## Zoom out, then zoom in

Personalization usually makes people reach for fine-tuning or a separate "user
model." buffr does it with one string concatenation and zero extra model calls:
the `me.md`-style profile is read from Postgres and prepended to the system prompt
every turn. That's the whole feature.

```
  Zoom out — where personalization lives

  ┌─ Storage (this repo) ─────────────────────────────────────┐
  │  agents.profiles  (me.md content, per app_id)             │
  └───────────────────────────┬──────────────────────────────┘
                             │ loadProfile()  src/profile.ts
  ┌─ buffr session ─────────────▼────────────────────────────┐
  │  new RagQueryAgent({ profile })           src/session.ts │
  └───────────────────────────┬──────────────────────────────┘
                             │ profile string
  ┌─ aptkit agent ──────────────▼────────────────────────────┐
  │  ★ injectProfile: prepend to BASE_SYSTEM ★               │ ← we are here
  └───────────────────────────────────────────────────────────┘
```

Zoom in: the concept is **persona injection** — making the assistant answer "for
this specific person" by putting a profile block at the front of the system prompt,
where it frames everything that follows. The question it answers: *how do you
personalize without training or a second call?*

## Structure pass

One axis — **how often does this part of the prompt change?** — separates the
constant skeleton from the per-user slot.

```
  Axis: "constant across users, or per-user?"

  ┌─ system prompt ───────────────────────────────────────┐
  │  [# About the person…]  ← PER-USER  (the profile slot) │
  │  [profile text]         ← PER-USER  (from agents.profiles)
  │  ─────────────────────────────────────────────────────│ ← seam: per-user │ constant
  │  [BASE_SYSTEM]          ← CONSTANT  (call search, cite)│
  │  [tool catalog text]    ← CONSTANT  (appended by Gemma)│
  └───────────────────────────────────────────────────────┘
```

The seam is the line between the profile block and `BASE_SYSTEM`. Above it: swaps
per user, sourced from the DB. Below it: identical for everyone. The spec's anatomy
rule — *constant goes in system, per-call varies* — is literally drawn here, except
the "per-call" axis is "per-user," and the profile sits at the *front* so it
conditions the constant instruction rather than the other way around.

## How it works

### Move 1 — the shape

You know how a React context provider wraps a subtree so every child reads the same
value? Profile injection is that, for the prompt: the profile block wraps the whole
system prompt, so every instruction below it is read "in light of this person."

```
  Pattern — profile as the outermost frame

  ┌─ profile block (prepended) ───────────────┐
  │  # About the person you are assisting     │
  │  <me.md content>                          │
  │  ┌─ BASE_SYSTEM ───────────────────────┐  │
  │  │ call search, ground, cite sources   │  │ ← read "for this person"
  │  └─────────────────────────────────────┘  │
  └───────────────────────────────────────────┘
```

### Move 2 — the walkthrough

**Read the profile from Postgres (buffr).** Most-recent row wins; absent is `''`.

```ts
// src/profile.ts:4
export async function loadProfile(pool, appId): Promise<string> {
  const { rows } = await pool.query(
    'select content from agents.profiles where app_id = $1 order by updated_at desc limit 1', [appId]);
  return rows[0]?.content ?? '';          // no profile → '' → injection is skipped downstream
}
```

The boundary condition is the `?? ''`. An empty string means the agent simply runs
with no profile block — personalization degrades to nothing, the assistant still
works. You can never crash the prompt by lacking a profile.

**Prepend it before rendering (aptkit).** The agent injects only when the profile
is non-empty, positions it at `start`, and tags it with a heading.

```ts
// rag-query-agent.js:20, 29-32
const PROFILE_HEADING = '# About the person you are assisting';
const withProfile = options.profile
  ? injectProfile(template, options.profile, { position: 'start', heading: PROFILE_HEADING })
  : template;                                            // empty profile → bare BASE_SYSTEM
this.system = renderPromptTemplate(withProfile, {});     // inject THEN render — order matters
```

```ts
// profile-injector.js:18-22 — the actual concatenation
const block = heading ? `${heading}\n${profileText}` : profileText;
return position === 'end' ? `${systemTemplate}\n\n${block}`
                         : `${block}\n\n${systemTemplate}`;    // start: profile first
```

The ordering decision is deliberate and documented: **inject, then render.**
`injectProfile` runs before `renderPromptTemplate` so that `{placeholder}` syntax
in the *template* still resolves — the profile is dropped in as a plain block that
doesn't disturb templating. The production smell to flag (also raised in file 01):
if a profile ever contained a literal `{schema}`, the subsequent `renderPromptTemplate`
would try to resolve it and either throw or blank it. buffr's `me.md` is plain
prose, so it's safe today — but it's an untrusted-string-meets-template-engine seam
sitting one layer from your DB.

```
  Layers-and-hops — profile from DB to prompt

  ┌─ Postgres ────┐ hop 1: select content   ┌─ buffr ─────────┐
  │ agents.profiles│ ──────────────────────► │ loadProfile()   │
  └───────────────┘                         └────────┬────────┘
                          hop 2: profile string       ▼
                                            ┌─ aptkit agent ──┐
                          hop 3: prepend +  │ injectProfile + │
                          render            │ renderTemplate  │
                                            └────────┬────────┘
                          hop 4: system string ▼
                                          → Gemma provider (file 02)
```

### Move 3 — the principle

Personalization is cheapest as **context, not weights.** A profile block in the
system prompt gives per-user behavior with no training, no second model call, and a
DB row you can edit live — at the cost of the tokens it spends every turn and the
fact that nothing *enforces* the model honors it (it's an instruction, not a
constraint). For a single-device personal agent, that trade is obviously right.

## Primary diagram

```
  Profile injection — read once, frame every turn

  agents.profiles ──loadProfile──► profile string ──injectProfile(start)──►
                                                                            │
                   ┌────────────────────────────────────────────────────┐ │
                   │ # About the person you are assisting                │◄┘
                   │ <me.md>                                             │
                   │                                                     │
                   │ <BASE_SYSTEM: call search, ground, cite>            │
                   └────────────────────────────────────────────────────┘
                                  → renderPromptTemplate → Gemma provider
```

## Elaborate

This is the standard "system prompt persona" pattern — the same move ChatGPT's
custom instructions and Claude's system prompt make. The interesting buffr-specific
choice is sourcing it from a *database row* keyed by `app_id` rather than a file or
a constant, which means the profile can be updated without a redeploy and is
captured in the same persistence story as conversations (`context.md` data model,
`profiles` table). It also composes with retrieval memory: the profile is the
*static* "who you are," while remembered exchanges (the search tool, surfaced as
context) are the *dynamic* "what we've discussed" — two personalization channels,
one static and one retrieved.

## Interview defense

**Q: "How is the assistant personalized?"**
One prepend, no training. A `me.md`-style profile is read from a Postgres row and
injected at the *front* of the system prompt under a heading, so every instruction
below it is read "for this person." The position matters — front, not back — so it
frames the constant `BASE_SYSTEM` rather than being an afterthought. It degrades
safely: no profile means an empty string and a bare system prompt, never a crash.

```
  profiles row → loadProfile → [profile] + [BASE_SYSTEM] → model
   per-user                     prepended    constant
```

Anchor: *"Personalization as context, not weights — a DB row, editable live."*

## See also

- [`01-three-owner-prompt-assembly.md`](01-three-owner-prompt-assembly.md) — this is the Owner 1→2 hop
- [`04-grounding-and-citation-instruction.md`](04-grounding-and-citation-instruction.md) — the `BASE_SYSTEM` the profile frames
- `study-ai-engineering` — retrieval memory as the *dynamic* personalization channel
