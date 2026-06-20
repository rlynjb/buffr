# Profile as context — me.md injected into the system prompt

**Industry name(s):** Persona / profile injection / system-prompt context grounding · Project-specific pattern.

## Zoom out, then zoom in

A personal RAG agent should answer *for you* — knowing who "the author" is, what "my stack" means, without you re-stating it every question. buffr does this by storing a `me.md`-style profile in the database and injecting it into the system prompt at the front of every conversation. It's the difference between a generic assistant and one that knows whose knowledge base it's searching.

```
  Zoom out — where the profile enters

  ┌─ CLI layer ──────────────────────────────────────────────┐
  │  ask-cmd.ts → loadProfile(pool, appId)                    │
  └───────────────────────────┬──────────────────────────────┘
                              │  profile text
  ┌─ Agent construction ──────▼──────────────────────────────┐
  │  RagQueryAgent({ profile }) → ★ injectProfile ★           │ ← we are here
  │   profile prepended to system template, at 'start'        │
  └───────────────────────────┬──────────────────────────────┘
  ┌─ Provider ────────────────▼──────────────────────────────┐
  │  Gemma sees: [profile] + [search instruction] + question │
  └───────────────────────────┬──────────────────────────────┘
  ┌─ Storage ─────────────────▼──────────────────────────────┐
  │  agents.profiles (content, updated_at) — read most-recent │
  └───────────────────────────────────────────────────────────┘
```

Zoom in: the profile is durable context that lives in the database, not in the prompt source. It's loaded per run, prepended to the system template under a heading, and rendered into the final system string before the loop starts. The model reads it once, at the top of context, where attention is strongest — and every answer is implicitly grounded in "who I'm assisting."

## Structure pass

Three layers, one axis: **where does the profile live, and when does it bind to the prompt?**

```
  Axis traced = "where it lives, when it binds"

  ┌─ storage: agents.profiles ──────────┐  lives in DB — mutable, durable
  │  content text, order by updated_at   │  → editable without code change
  └──────────────────┬───────────────────┘
                     │  seam ① — DB ═╪═ runtime (loadProfile reads latest)
  ┌─ runtime: loadProfile → string ─────┐  lives in memory — per-run snapshot
  │  most-recent row, or '' if none      │  → bound at construction time
  └──────────────────┬───────────────────┘
                     │  seam ② — string ═╪═ prompt (injectProfile prepends)
  ┌─ prompt: system template ───────────┐  lives in the system string — frozen
  │  [profile heading + text] + template │  → fixed for the whole conversation
  └──────────────────────────────────────┘
```

The two seams mark the profile's journey from editable data to frozen prompt. **Seam ①**: the profile is *data* in the database — you can edit it (a new row, latest wins) without redeploying. **Seam ②**: at agent construction, `injectProfile` freezes it into the system string for the run's duration. The load-bearing point: the profile is context the user controls *as data*, not a hardcoded persona — and it binds once per run, so editing it mid-conversation has no effect until the next `ask`.

## How it works

Mental model: you know how a system prompt sets the assistant's standing instructions for a whole chat? Profile injection is prepending a "here's who you're talking to" block above those instructions — like a React context provider wrapping a tree, except the "context" is text at the top of the LLM's window.

```
  Profile injection — data becomes the head of the prompt

  agents.profiles (latest row)
     │  loadProfile(pool, appId) → "I'm Rein, I build RAG systems..."
     ▼
  injectProfile(template, profile, {position:'start', heading})
     │
     ▼
  ┌─ final system string ──────────────────────────────────┐
  │ # About the person you are assisting                   │ ← heading
  │ I'm Rein, I build RAG systems, my stack is...          │ ← profile (DB)
  │                                                         │
  │ You are a personal knowledge assistant.                │ ← template
  │ Always call search_knowledge_base first...             │
  └────────────────────────────────────────────────────────┘
     │  renderPromptTemplate resolves any {{placeholders}}
     ▼
  the system prompt every loop turn sees
```

### Step 1 — load the most-recent profile from the database

`loadProfile(pool, appId)` selects `content` from `agents.profiles` ordered by `updated_at desc`, limit 1 — the latest profile for this app. If there's no row, it returns `''` (empty string), not null. Boundary condition: empty-string is the "no profile" signal, and the agent handles it by skipping injection entirely — so a fresh install with no profile still works, just without personalization.

### Step 2 — inject it at the start, under a heading

`RagQueryAgent`'s constructor calls `injectProfile(template, profile, { position: 'start', heading: '# About the person you are assisting' })`. Position `'start'` prepends — the profile lands *before* the assistant instructions. Why the front? It's the highest-attention region of the context window (the lost-in-the-middle problem means the start and end are attended-to most), so "who I'm assisting" is where the model reads best. The heading frames it so the model knows it's profile context, not part of its instructions.

### Step 3 — render and freeze

`renderPromptTemplate(withProfile, {})` resolves any template placeholders and produces the final immutable `system` string stored on the agent. From here, every `model.complete` call in the loop passes this same system string. Boundary condition: it's frozen at construction — `loadProfile` runs once in `ask-cmd.ts` before the agent is built, so the profile is a per-run snapshot. A profile edit takes effect on the *next* `ask`, never mid-run.

### Move 2.5 — current state vs the lost-in-the-middle cost

```
  Profile competes for the context window

  current: [profile][instructions][question][tool results...]
            ▲ front = high attention ✓

  but as tool results accumulate over turns:
           [profile][instructions]...[result][result][result][question]
            ▲ still front           ▲ middle = low attention
  a long profile + many tool results can push the question toward
  the lost-in-the-middle zone. 8192-token guard (file 03) bounds it,
  but profile length is an untuned knob
```

Current state: the profile sits at the front, which is right. What's untuned: there's no budget on profile length, so a very long `me.md` eats into the 8192-token window that retrieved chunks also need. At buffr's scale this is fine; it's named because it's the knob that would matter first if profiles grew.

### Move 3 — the principle

User-controlled context belongs in data, injected at the high-attention edge of the window, bound once per run. The principle: personalization isn't a hardcoded persona — it's editable data the user owns, placed where the model actually reads it. Putting it at the *start* (not buried mid-prompt) is the difference between the model using it and ignoring it.

## Primary diagram

The full profile path, data to frozen prompt.

```
  buffr profile-as-context — full recap

  ┌─ agents.profiles (DB) ────────────────────────────────────┐
  │  select content order by updated_at desc limit 1          │
  └───────────────────────────┬───────────────────────────────┘
                              │ loadProfile → string | ''
  ┌─ ask-cmd.ts ──────────────▼───────────────────────────────┐
  │  const profile = await loadProfile(pool, cfg.appId)       │
  │  new RagQueryAgent({ model, tools, profile, trace })      │
  └───────────────────────────┬───────────────────────────────┘
                              │ injectProfile(position:'start')
  ┌─ frozen system string ────▼───────────────────────────────┐
  │  # About the person...    ← profile (front, high-attention)│
  │  You are a personal knowledge assistant. Always search...  │
  └───────────────────────────┬───────────────────────────────┘
                              │ every loop turn
                           Gemma (file 03/04)
```

## Implementation in codebase

**Use cases.** Runs on every `ask`. The profile makes "what's my stack?" resolvable — without it, the model has no idea who "my" refers to. It's how buffr turns a generic RAG agent into *your* personal knowledge agent. The profile is editable as data (insert a new `profiles` row), so you update your persona without touching code.

**Code side by side.**

```
  src/profile.ts  (lines 4–8)

  export async function loadProfile(pool, appId): Promise<string> {
    const { rows } = await pool.query(
      'select content from agents.profiles where app_id = $1 ' +
      'order by updated_at desc limit 1', [appId]);            ← latest wins
    return rows[0]?.content ?? '';                            ← '' = no profile
  }
       │
       └─ returns '' not null on miss — so the agent's `profile ? inject : skip`
          check works cleanly and a profile-less install still runs
```

```
  src/cli/ask-cmd.ts  (lines 27, 33)

  const profile = await loadProfile(pool, cfg.appId);   ← load ONCE, per run
  ...
  const agent = new RagQueryAgent({ model, tools, profile, trace });
       │
       └─ loaded before the agent is constructed → frozen for the whole run.
          edit the profile mid-conversation? no effect until the next ask
```

```
  library RagQueryAgent constructor — the injection (for grounding)

  const withProfile = options.profile
    ? injectProfile(template, options.profile,
        { position: 'start', heading: '# About the person you are assisting' })
    : template;                                          ← skip if no profile
  this.system = renderPromptTemplate(withProfile, {});
       │
       └─ position:'start' = front of context = highest attention. NOT buried
          in the middle where the model would under-weight it
```

## Elaborate

Profile injection is the production shape of "give the assistant standing context about its user." It connects directly to two spec concepts: the *context window* (the profile competes for finite space) and *lost-in-the-middle* (which is exactly why it goes at the start). buffr's `me.md`-style profile is the same idea as this study guide's own reader-calibration file — durable context that personalizes every interaction.

The design is clean: data in the database (editable, durable, per-app), loaded per run (a consistent snapshot), injected at the high-attention edge (where it's actually used). The one untuned knob is length budgeting — no cap on how much of the 8192-token window the profile may consume, which would matter only if profiles grew large relative to the corpus chunks they share the window with.

What to read next: `03-agent-loop-with-tool-calling.md` (the loop that carries this system prompt every turn) and `02-rag-query-path.md` (the corpus the profile contextualizes).

## Project exercises

> No `aieng-curriculum.md` present; exercises name the buildable target directly.

### Budget the profile against the context window

- **What to build:** Cap the injected profile to a token budget (e.g. truncate or summarize when it exceeds N tokens) so it can't crowd out retrieved chunks in the 8192-token window.
- **Why it earns its place:** Shows you understand the profile and the corpus compete for context — "I budget my persona against my retrieval so neither starves" is a real context-management story.
- **Files to touch:** `src/profile.ts` (truncate/summarize), `src/cli/ask-cmd.ts` (pass the budget).
- **Done when:** a test with an oversized profile proves it's capped before injection.
- **Estimated effort:** 1–4hr.

### Add a profile-write CLI

- **What to build:** A `profile-cmd.ts` that reads a local `me.md` and inserts it as a new `agents.profiles` row, making the latest-wins behavior usable from the command line.
- **Why it earns its place:** Completes the "profile as editable data" story end to end — the read path exists, the write path is manual SQL today.
- **Files to touch:** new `src/cli/profile-cmd.ts`, `package.json` (script).
- **Done when:** `npm run profile -- me.md` updates the active profile and the next `ask` reflects it.
- **Estimated effort:** <1hr.

## Interview defense

**Q: How does your agent know who "the author" is in a question?**

```
  agents.profiles (DB) → loadProfile → injectProfile(position:'start')
  profile sits at the FRONT of the system prompt = highest attention
```

"A `me.md`-style profile lives in the database and gets injected at the front of the system prompt every run. It's the high-attention region, so the model actually uses it — 'what's my stack' resolves because the profile is right there at the top." Anchor: user context belongs in data, injected where the model reads best.

**Q: Why the front, and when does an edit take effect?**

"Front because of lost-in-the-middle — start and end are attended-to most, so persona context buried mid-prompt gets under-weighted. And it's loaded once before the agent is built, so it's a per-run snapshot; editing the profile takes effect on the next `ask`, never mid-conversation." Anchor: bound once per run, placed at the high-attention edge.

## Validate

- **Reconstruct:** Trace the profile from `agents.profiles` to the frozen system string, naming the heading and position. (`src/profile.ts:6`, library `injectProfile`)
- **Explain:** Why does `loadProfile` return `''` instead of `null` on a miss? (`src/profile.ts:7`)
- **Apply:** A user edits their profile while an `ask` is mid-loop. Does the running answer change? Why or why not? (`src/cli/ask-cmd.ts:27` — loaded before construction)
- **Defend:** The profile injects at `position: 'start'`. Defend that over `'end'`, citing the context-window behavior. (library `injectProfile` call in `RagQueryAgent`)

## See also

- `03-agent-loop-with-tool-calling.md` — carries this system prompt every turn.
- `02-rag-query-path.md` — the corpus the profile contextualizes.
- `06-evals-precision-and-recall.md` — note: the eval path skips the agent, so it doesn't exercise the profile.
- `.aipe/study-system-design/06-profile-injection-as-context.md` — the architectural view of the same injection.
