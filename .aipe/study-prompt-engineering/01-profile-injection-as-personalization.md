# Profile injection as personalization

**Industry name(s):** Profile injection / standing context / persona priming · *Industry standard*

---

## Zoom out, then zoom in

There are two ways to get user-specific text into a prompt. One is
retrieval — the model asks for it via a tool. The other is **standing
context** — you prepend it unconditionally, every call, no asking. The
`me.md`-style profile in buffr is the second kind. It's the answer to
"who am I talking to," and it's stitched onto the front of the system
prompt before the model sees a single grounding rule.

```
  Zoom out — two context paths into the prompt

  ┌─ Storage (Postgres, agents schema) ──────────────────────────┐
  │  profiles table          chunks table (pgvector)             │
  └───────┬──────────────────────────────┬───────────────────────┘
          │ unconditional                │ on-demand (tool call)
          │ (every call)                 │ (model asks)
  ┌───────▼──────────────────┐   ┌───────▼───────────────────────┐
  │ ★ PROFILE INJECTION ★    │   │ retrieval (search tool)        │
  │   this guide             │   │ → 02-grounding…                │
  └───────┬──────────────────┘   └────────────────────────────────┘
          │ prepended to
  ┌───────▼──────────────────────────────────────────────────────┐
  │ Service: system prompt = profile + BASE_SYSTEM                │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is *prepend a document to the system template under
a heading, before rendering*. It's the prompt-engineering equivalent of
a React context provider — set once at the top, every consumer below
sees it without re-fetching. Here the "consumers" are every turn of the
agent loop.

---

## Structure pass

**Layers.** Storage (the `profiles` row) → buffr CLI (`loadProfile`) →
aptkit agent (`injectProfile` + render) → provider (the final system
string).

**Axis — *who controls whether this text is present?*** Trace it down:

```
  axis: who decides the profile is in the prompt?

  ┌─ Storage ───────────┐   row exists or not  → DATA decides presence
  └─────────┬───────────┘
  ┌─ CLI ───▼───────────┐   loadProfile → ''   → CODE decides (always tries)
  └─────────┬───────────┘
  ┌─ Agent ─▼───────────┐   profile ? inject   → CODE decides (truthy gate)
  └─────────┬───────────┘
  ┌─ Provider ▼─────────┐   it's just text now → nobody; it's baked in
  └─────────────────────┘
```

**The seam that matters:** the truthy gate in the `RagQueryAgent`
constructor. On one side, an empty profile string; on the other, either
the bare template or a profile-prepended one. The model **never** asks
for the profile and **never** knows whether one was injected — control
over its presence flips entirely to code, at construction time, before
the loop ever runs. That's what makes it *standing* context.

---

## How it works

### Move 1 — the mental model

You know how a system prompt usually opens with "You are a helpful
assistant"? Profile injection slots a whole document in front of that —
"here is *who* you're helping" — so the persona is primed before the
rules. The shape is a single string concatenation with a heading.

```
  The pattern — prepend-with-heading

         profileText            BASE_SYSTEM template
        ┌────────────┐         ┌──────────────────────┐
        │ work.md    │         │ You are a personal   │
        │ coffee.md  │         │ knowledge assistant. │
        │ stack.md   │         │ Always call search…  │
        └─────┬──────┘         └──────────┬───────────┘
              │                            │
              ▼                            ▼
   "# About the person…\n" + profile  +  "\n\n"  +  template
   └──────────────────── one system string ────────────────────┘
                  (position: 'start' → profile wins the front)
```

### Move 2 — the walkthrough

**Read the row.** buffr's own code, `src/profile.ts:4` — one query,
most-recent-wins:

The profile is whatever the user stored in `agents.profiles`. If there's
no row, `loadProfile` returns `''`. That empty string is load-bearing —
it's what the truthy gate downstream checks. Without the `?? ''`, a
missing profile would be `undefined` and the gate's behavior would hinge
on that distinction. Here it's normalized to falsy-but-defined.

**Hand it to the agent.** `ask-cmd.ts:27` calls `loadProfile`, then
`:33` passes it as `{ profile }` into `RagQueryAgent`. buffr's job ends
here — it loaded a string and handed it over. Everything else is the
library.

**Inject before render.** This is the subtle ordering decision.
`rag-query-agent.js:29-32`:

```
  inject THEN render — order matters

  withProfile = profile
    ? injectProfile(template, profile, {start, heading})   ← step 1
    : template
  this.system = renderPromptTemplate(withProfile, {})      ← step 2
```

Why inject *before* render? Because `injectProfile`
(`profile-injector.js:15-22`) is pure string concatenation that leaves
`{placeholder}` tokens untouched, and `renderPromptTemplate`
(`@aptkit/prompts/types.js:1-6`) resolves those tokens afterward. If the
profile itself contained a literal `{schema}`, rendering after injection
means it'd be… still left alone here (buffr passes `{}` as variables, so
nothing resolves). The ordering is the library's contract: profile is
data, template is template, and injection preserves the template's
renderability. The docstring at `profile-injector.js:5-8` states this
explicitly.

**The concatenation.** `profile-injector.js:18-21`:
`block = heading + "\n" + profileText`, then for `position: 'start'`,
`block + "\n\n" + systemTemplate`. The heading
(`# About the person you are assisting`, `rag-query-agent.js:20`) is a
Markdown H1 — a clear visual boundary the model reads as "this section
is about the user." Drop the heading and the profile text bleeds into
the identity line with no delimiter; the model can't tell where "who you
are" ends and "who you're helping" begins.

### Move 3 — the principle

Personalization that the model can't forget to fetch belongs in
**standing context**, not retrieval. If "who is this user" must shape
*every* answer, you prepend it unconditionally — you don't make the
model decide to look it up, because a weak model will forget. Retrieval
is for the long tail you can't afford to always include; standing
context is for the short, always-relevant head. The profile is the head.

---

## Primary diagram

The full path, one frame.

```
  Profile injection — storage to system string

  ┌─ Postgres: agents.profiles ──────────────────────────────────┐
  │  select content … order by updated_at desc limit 1           │
  └───────────────────────────┬──────────────────────────────────┘
                              │ profile.ts:4  →  string | ''
  ┌─ ask-cmd.ts ──────────────▼──────────────────────────────────┐
  │  const profile = await loadProfile(pool, cfg.appId)   :27     │
  │  new RagQueryAgent({ model, tools, profile, trace })  :33     │
  └───────────────────────────┬──────────────────────────────────┘
                              │ profile string
  ┌─ RagQueryAgent ctor ──────▼──────────────────────────────────┐
  │  profile ? injectProfile(template, profile,                  │
  │              {position:'start', heading:'# About the…'})  :29 │
  │          : template                                          │
  │  this.system = renderPromptTemplate(withProfile, {})     :32  │
  └───────────────────────────┬──────────────────────────────────┘
                              │ one system string (profile FIRST)
  ┌─ runAgentLoop / Gemma provider ──────────────────────────────┐
  │  system text reused on EVERY turn (run-agent-loop.js:30)     │
  └───────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use case.** You ask buffr "how do I take my coffee?" The eval set
(`eval/queries.json`) shows this is a real query against a `coffee.md`
document — but the *profile* is separate: it's the standing "about me"
that colors tone and assumptions across every answer, loaded fresh each
run so editing your profile row changes the next answer with no redeploy.

**The buffr side — `src/profile.ts:1-8`:**

```
  src/profile.ts  (lines 4-7)

  const { rows } = await pool.query(
    'select content from agents.profiles
       where app_id = $1 order by updated_at desc limit 1',  ← newest profile wins
    [appId]);                                                ← per-app (default 'laptop')
  return rows[0]?.content ?? '';                             ← no row → '' (falsy gate fuel)
       │
       └─ the ?? '' is what lets the agent's `profile ? …` gate
          cleanly skip injection when no profile is stored
```

**The library side — `@aptkit/context/profile-injector.js:15-22`:**

```
  profile-injector.js  (lines 18-21)

  const block = heading ? `${heading}\n${profileText}` : profileText;  ← heading delimits
  return position === 'end'
    ? `${systemTemplate}\n\n${block}`                                   ← append variant
    : `${block}\n\n${systemTemplate}`;                                 ← buffr uses this (start)
       │
       └─ pure string-in/string-out: never touches fs, leaves {tokens}
          intact so renderPromptTemplate can still run after (the
          inject-then-render contract, docstring lines 5-8)
```

**The wiring — `rag-query-agent.js:29-32`** prepends with the
`# About the person you are assisting` heading at `position: 'start'`,
then renders. buffr passes `profile` in at `ask-cmd.ts:33`; it never
passes a custom `prompt`, so the default BASE_SYSTEM template
(`:12-19`) is what the profile gets prepended to.

---

## Elaborate

Profile injection is the production form of "system prompt
personalization." The canonical version in the literature is the
persona/role line ("You are a financial analyst"); the document form
buffr uses scales that up to a whole `me.md`. The reader has shipped this
shape before — AdvntrCue's MemoRAG session memory is the retrieval cousin
(context the model *fetches*); this is the *always-present* cousin.

The design tension worth naming: standing context costs tokens on every
call (it rides in the system prompt the context guard measures —
`context-window-guard.js:60`). A bloated profile eats budget that
retrieved chunks need. The discipline is keeping the profile short and
putting the long tail in retrieval. buffr's profiles are small `.md`
documents, which is the right scale.

The position choice (`start`) interacts with **lost-in-the-middle**:
content at the front of a long prompt is attended better than content in
the middle. Profile-at-front is the right call for content that must
shape every answer. (buffr doesn't yet have a long enough prompt for
this to bite — but the position decision is already correct.)

---

## Interview defense

**Q: Why inject the profile unconditionally instead of letting the agent
retrieve it with a tool?**

Because a weak model will forget to call the tool, and "who is this user"
must shape *every* answer, not just the ones where the model remembers
to ask. Standing context is for the always-relevant head; retrieval is
for the long tail. The load-bearing part people forget: the **truthy
gate** (`rag-query-agent.js:29`) — an empty profile must cleanly skip
injection, or you prepend a stray heading with no content and confuse
the model about an empty "about the user" section.

```
  retrieval (model decides)   vs   standing (code decides)
  ┌──────────────┐                 ┌──────────────┐
  │ may forget    │                 │ always present│
  │ costs a turn  │                 │ costs tokens  │
  │ long tail     │                 │ short head    │
  └──────────────┘                 └──────────────┘
```

**Anchor:** "Profile is standing context — prepended at construction
(`profile-injector.js:18`), the model never fetches it."

---

## Validate

- **Reconstruct.** From memory, write the two-step order in the
  `RagQueryAgent` constructor (`rag-query-agent.js:29-32`). Which runs
  first, inject or render, and why?
- **Explain.** Why does `profile.ts:7` return `''` instead of letting a
  missing row propagate as `undefined`? Trace what the gate at
  `rag-query-agent.js:29` does with each.
- **Apply.** A user's profile is 4,000 tokens and `ask-cmd.ts` sets the
  guard to 8192 (`:26`). On a long retrieval, the guard throws
  (`context-window-guard.js:37`). Where do you cut — profile or chunks —
  and why?
- **Defend.** Someone proposes moving the profile to `position: 'end'`
  so the grounding rules come first. Argue for or against, using
  lost-in-the-middle and the heading delimiter.

---

## See also

- [`02-grounding-and-citation-instruction.md`](02-grounding-and-citation-instruction.md)
  — what the profile gets prepended *to*
- [`00-overview.md`](00-overview.md) — the full assembled prompt
- [`study-agent-architecture/06-profile-as-standing-context.md`](../study-agent-architecture/06-profile-as-standing-context.md)
  — the same injection viewed as agent memory
