# 06 — Profile Injection as Context

**Industry name(s):** system-prompt context injection · the persona / profile layer · stored-context-into-prompt. **Type:** Industry standard (LLM systems).

## Zoom out — where this concept lives

A generic RAG box answers questions. The thing that makes it *your* assistant — answers in your
voice, knows who's asking — is one extra string fed into the system prompt: the profile (a
`me.md`-style document stored as a row). It's read once at session start and injected into the
agent's prompt before any turn runs.

```
  Zoom out — profile injection in the system

  ┌─ Storage layer ───────────────────────────────────────────────┐
  │  agents.profiles — the me.md-style profile, one row per app    │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  loadProfile() — read once (session start)
  ┌─ Session layer (buffr owns) ──▼──────────────────────────────┐
  │  ★ profile string ★  passed into new RagQueryAgent({ profile })│
  └───────────────────────────────┬──────────────────────────────┘
                                  │  aptkit injects it into the system prompt
  ┌─ Agent / Provider layer ──────▼──────────────────────────────┐
  │  system prompt = [ profile ] + retrieved chunks + question    │
  │  → Gemma answers grounded AND in-voice                        │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **context injection** — putting durable, user-specific text into the system
prompt so every answer is shaped by it. The question it answers: *how does the model know who it's
talking to and what voice to use, without that being in the question?* Answer — it's not in the
question; it's standing context injected ahead of every turn.

## Structure pass — layers, axis, seam

**Layers:** stored profile (row) → loaded string (session) → system prompt (agent) → model.

**Axis — trace *where does this piece of state live* across the layers:**

```
  axis = "where does the profile live at each layer?"

  storage   →  a row in agents.profiles          (durable, editable)
  session   →  a string in a closure variable     (read once, held)
  agent     →  part of the assembled system prompt (per-turn input to the model)
  model     →  conditioning on every token it emits (shapes voice + grounding)

  one piece of content, four homes — durable → loaded → injected → conditioning.
```

**The seam:** the `profile` parameter on `new RagQueryAgent({ ..., profile })` (`session.ts:57`).
On the storage side it's a row buffr reads; on the agent side it's prompt context aptkit assembles.
buffr never builds the prompt — it hands the string across the seam and aptkit injects it. That
keeps prompt-assembly in the library and profile-storage in the body.

## How it works

### Move 1 — the mental model

You know how a React context provider sets a value once at the top and every component below reads
it without it being passed through props. The profile is that for the prompt: set once at the top of
the session, present in every turn's system prompt, never part of the per-question payload. Standing
context, not per-call argument.

```
  Context injection — one read, every turn shaped

  agents.profiles row
        │ loadProfile() once
        ▼
  profile string ──► RagQueryAgent({ profile })
                          │ aptkit assembles each turn:
                          ▼
        ┌──────────────────────────────────────┐
        │ SYSTEM: <profile>  ← who you are/voice │  every turn
        │ CONTEXT: <retrieved chunks (02)>       │  per question
        │ USER: <question>                       │  per question
        └──────────────────────────────────────┘
                          ▼
                    model answers in-voice + grounded
```

### Move 2 — the walkthrough

**Read once — the profile load.** A single query gets the most recent profile for the app
(`profile.ts:4-8`):

```ts
// src/profile.ts:4
export async function loadProfile(pool: pg.Pool, appId: string): Promise<string> {
  const { rows } = await pool.query(
    'select content from agents.profiles where app_id = $1 order by updated_at desc limit 1',
    [appId]);
  return rows[0]?.content ?? '';        // no profile → empty string, not a crash
}
```

Two boundary details. `order by updated_at desc limit 1` means edits win — update the profile row and
the newest one is used; the table keeps history but the agent reads the latest. And `?? ''` makes the
profile *optional*: no row, empty string, the agent still runs — it just isn't personalized. The
profile degrades to "generic assistant," it doesn't fail.

**Read once, at session start — not per turn.** `loadProfile` is called in the build-once block of
the session (`session.ts:47`), not inside `ask`:

```ts
// src/session.ts:47
const profile = await loadProfile(pool, cfg.appId);   // read once — profile is session-stable
// ...
const agent = new RagQueryAgent({ model, tools, profile, trace });  // injected at construction
```

This is a lifecycle decision (cross-link `05`): the profile doesn't change mid-conversation, so it's
read once and closed over, like the agent itself. If you edit your profile, you start a new session to
pick it up — the cost of reading once instead of per turn.

**Inject across the seam — buffr hands the string, aptkit builds the prompt.** The `profile` parameter
on `RagQueryAgent` (`session.ts:57`) is the whole injection point on buffr's side. buffr does *not*
assemble the system prompt — it passes the string and aptkit's agent prepends it into the system
template before each turn (the `injectProfile` helper, designed pure — "string in, string out" —
`aptkit-packages-design.md:236-258`). The division of labor is the seam: storage and the *decision to
inject* are buffr's; the *prompt assembly* is aptkit's. buffr can't accidentally couple to aptkit's
prompt format because it never touches it.

**What the model sees — profile + chunks + question.** At answer time the assembled prompt carries
three layers: the profile (standing, who/voice), the retrieved chunks (per-question grounding, from
`02`), and the question. The profile conditions *voice and identity*; the chunks condition *facts*.
That separation is why an answer can be both grounded (chunks) and in-character (profile) — they're
different slots in the same prompt.

### Move 2 variant — the load-bearing skeleton

```
  Profile-injection kernel:
    1. profile stored as a row        — editable, versioned by updated_at
    2. read once at session start     — session-stable, not per-turn
    3. optional (?? '')               — no profile → generic, not a crash
    4. injected via agent param       — buffr hands a string, aptkit builds the prompt
```

- Drop **#1** (hardcode the profile) → can't edit your assistant without a code change; the "me.md as
  a row" idea (`...graduation-design.md:119`) is the point.
- Drop **#3** → a fresh DB with no profile crashes the agent on the first turn.
- Drop **#4's seam** (build the prompt in buffr) → buffr couples to aptkit's prompt format; the
  library boundary (`04`) leaks.

Optional hardening *not* here: per-user profiles (the `user_id` column exists, unused —
`sql/001:54`), profile templating, hot-reload mid-session. All deferred.

### Move 3 — the principle

**Durable, user-specific context belongs in the system prompt as standing input, not in the
per-question payload — so every answer is shaped by it without the user repeating themselves.** The
profile is the cheapest, highest-leverage piece of an agent's personality: one string turns a generic
RAG box into "your" assistant. buffr keeps it a *row* (not code) so it's editable, and keeps injection
on aptkit's side of the boundary so buffr never owns prompt assembly.

## Primary diagram

```
  Profile Injection as Context — full picture

  ┌─ Storage ─────────────────────────────────────────────────────┐
  │  agents.profiles (app_id, content, updated_at)                 │
  │   loadProfile: order by updated_at desc limit 1, ?? ''         │
  └───────────────────────────────┬──────────────────────────────┘
            read ONCE (session start, session.ts:47)
  ┌─ Session (buffr) ─────────────▼──────────────────────────────┐
  │  profile: string  ──►  new RagQueryAgent({ profile })         │
  └───────────────────────────────┬──────────────────────────────┘
            the SEAM ─ buffr hands the string; aptkit assembles
  ┌─ Agent (aptkit) ──────────────▼──────────────────────────────┐
  │  system prompt per turn:                                      │
  │    [ profile  ] ← voice / identity (standing)                 │
  │    [ chunks   ] ← grounding facts  (per question, from 02)    │
  │    [ question ] ← the ask                                     │
  └───────────────────────────────┬──────────────────────────────┘
  ┌─ Provider ────────────────────▼──────────────────────────────┐
  │  Gemma — answers grounded (chunks) AND in-voice (profile)     │
  └───────────────────────────────────────────────────────────────┘
```

## Elaborate

This is the "persona" or "system prompt" layer every production LLM app has — the standing
instructions that aren't part of any single user message. buffr's specific move is storing it as
*data* (`agents.profiles`) rather than baking it into a prompt template, which is the difference
between "the assistant's personality is configuration" and "it's a code change." The design doc calls
it "the package that turns 'a RAG box' into '*your* assistant' — where `me.md` becomes live system
context instead of a doc only `aipe` reads" (`aptkit-packages-design.md:254-255`).

There's a clean separation worth naming: the profile conditions *voice*, the retrieved chunks (`02`)
condition *facts*. Both ride the same prompt but answer different needs — confusing them (stuffing
facts in the profile, or voice in the corpus) is the failure mode this separation avoids. The pure
`injectProfile(template, profileText)` signature (`aptkit-packages-design.md:243`) keeps the injection
testable and ESM-safe — the package never touches the filesystem; buffr reads the row and hands the
string in.

Read next: `02-retrieval-pipeline.md` (the chunks injected alongside the profile),
`05-long-lived-chat-session.md` (why it's read once), `04-library-as-dependency-boundary.md` (why
prompt assembly stays in aptkit). Prompt-construction craft → `study-prompt-engineering` /
`study-ai-engineering`.

## Interview defense

**Q: Where does the assistant's voice come from?**
A profile row (`agents.profiles`) read once at session start and injected into the system prompt as
standing context — not part of any question. The model conditions on it every turn, so answers come
out in-voice without the user asking for it (`profile.ts:4-8`, `session.ts:47,57`).

```
  profile row ─load once→ string ─inject→ SYSTEM prompt ─conditions→ every answer's voice
```

**Q: Why store it as a row instead of a constant in the prompt template?**
So it's editable as data, not code. `order by updated_at desc limit 1` means updating the row changes
the assistant with no deploy; the table keeps history. Hardcoding it would make personality a code
change and lose the "me.md as a row" idea. And `?? ''` makes it optional — a fresh DB runs generic,
doesn't crash.

**Q: Who builds the actual prompt — buffr or aptkit?**
aptkit. buffr only reads the row and passes the string via `RagQueryAgent({ profile })`; aptkit's
`injectProfile` assembles it into the system template. That keeps prompt format on the library side of
the boundary (`04`) — buffr can't couple to it. The seam is the `profile` parameter, nothing more.

## See also

- `02-retrieval-pipeline.md` — the chunks injected alongside the profile (facts vs voice).
- `05-long-lived-chat-session.md` — why the profile is read once, not per turn.
- `04-library-as-dependency-boundary.md` — prompt assembly stays in aptkit, storage in buffr.
- `audit.md` lens 3 (profile as source-of-truth state).
- `study-prompt-engineering` / `study-ai-engineering` → system-prompt construction.
