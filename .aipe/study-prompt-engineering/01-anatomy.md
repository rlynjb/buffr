# 01 — Anatomy of a production prompt

**Industry term:** prompt anatomy / prompt sections · the system prompt (`BASE_SYSTEM`) + context injection (`injectProfile`) · *Industry standard*

## Zoom out, then zoom in

Before the mechanism: where does "the prompt" even sit? You already know a `fetch()` has a URL, headers, and a body — three slots, each with one job, assembled into one request. A production prompt is the same shape: a handful of named slots, each owned by one part of the system, assembled into one string. Here's the band it lives in.

```
  Zoom out — where the prompt anatomy lives

  ┌─ UI layer ──────────────────────────────────────────┐
  │  Ink chat (src/cli/chat.tsx)  →  session.ask(q)      │
  └─────────────────────────┬────────────────────────────┘
                            │  question text
  ┌─ App + Toolkit layer ───▼────────────────────────────┐
  │  ★ PROMPT ANATOMY ★                                  │ ← we are here
  │  profile  +  BASE_SYSTEM  +  tool catalog  +  user   │
  └─────────────────────────┬────────────────────────────┘
                            │  one assembled string
  ┌─ Provider layer ────────▼────────────────────────────┐
  │  Gemma 2 9B via Ollama                               │
  └──────────────────────────────────────────────────────┘
```

Zoom in: a production prompt classically has **four sections** — system prompt, context injection, few-shot examples, user message. The job of this file is to map those four onto buffr's real assembly, name which owner contributes each, and show you the one section buffr is missing.

## Structure pass

**Layers:** app (buffr) → toolkit (`RagQueryAgent`) → provider (`GemmaModelProvider`). **Axis to trace — "constant vs per-call":** which sections are fixed across every turn, and which change per question? That single question sorts the sections cleanly.

```
  axis: "constant across turns, or per-call?"

  ┌─ system prompt (BASE_SYSTEM) ─┐ CONSTANT  (toolkit owns)
  ├─ context injection (profile)  ┤ CONSTANT* (app owns; *per-user, not per-turn)
  ├─ few-shot examples            ┤ — (absent)
  └─ user message (question)      ┘ PER-CALL  (app owns)
```

**Seam:** the boundary between constant and per-call is where prompts drift. Mix per-call data into the system section and you've coupled two lifecycles — that's the failure this anatomy prevents. buffr keeps them cleanly split: the question never touches the system text.

## How it works

### Move 1 — the mental model

The shape: four labeled boxes stacked into one string, top (most stable) to bottom (most volatile). Stability decreases as you go down. That ordering isn't cosmetic — it's also the prefix-cache ordering ([04-token-budgeting.md](04-token-budgeting.md)) and the injection-trust ordering ([12-prompt-injection-defense.md](12-prompt-injection-defense.md)).

```
  The four-section anatomy — stable on top, volatile on bottom

  ┌──────────────────────────────────────┐  most stable
  │ 1. SYSTEM PROMPT                      │  who the model is,
  │    "personal knowledge assistant"     │  the hard rules
  ├──────────────────────────────────────┤
  │ 2. CONTEXT INJECTION                  │  who the user is,
  │    profile (me.md)                    │  retrieved chunks
  ├──────────────────────────────────────┤
  │ 3. FEW-SHOT EXAMPLES   (absent here)  │  worked examples
  ├──────────────────────────────────────┤
  │ 4. USER MESSAGE                       │  the actual question
  │    "what does the author do for work" │
  └──────────────────────────────────────┘  most volatile
```

### Move 2 — the walkthrough

**The system prompt — the constant rules.** This is the model's job description, identical on every turn. In buffr it's `BASE_SYSTEM` (`DEFAULT_SYSTEM_TEMPLATE`), and it's four sentences doing four jobs: assign a role, mandate the search-first behavior, mandate grounding-and-citation, and mandate honest refusal.

```js
// agent-rag-query/dist/src/rag-query-agent.js:12
const DEFAULT_SYSTEM_TEMPLATE = [
  'You are a personal knowledge assistant.',          // role
  '',
  `Always call the ${SEARCH..} tool first to retrieve relevant`, // behavior
  'passages before answering. Ground every answer in the retrieved chunks and cite',
  'their sources. If the knowledge base does not contain the answer, say so plainly', // honesty
  'rather than guessing.',
].join('\n');
```

The boundary condition: nothing per-call goes here. The day you splice the user's question into the system prompt, you've broken the constant/per-call split and the next person to touch it can't reason about either piece alone.

**The context injection — who the user is.** This is the per-user constant. buffr reads the profile from Postgres (`loadProfile`, `src/profile.ts:4`) and the toolkit prepends it in front of the system prompt under a heading:

```js
// rag-query-agent.js:29 — inject BEFORE render
const withProfile = options.profile
  ? injectProfile(template, options.profile,
      { position: 'start', heading: PROFILE_HEADING })  // '# About the person you are assisting'
  : template;
this.system = renderPromptTemplate(withProfile, {});
```

`injectProfile` is a pure string-prepend (`profile-injector.js:15`) — heading, then profile, then a blank line, then the template. Position `'start'` means the profile sits at the very front of the whole prompt. Hold that fact; it comes back as a lost-in-the-middle question in [04-token-budgeting.md](04-token-budgeting.md) and an injection-surface question in [12-prompt-injection-defense.md](12-prompt-injection-defense.md).

**The user message — the per-call slot.** The question, untouched, as the sole user turn:

```js
// run-agent-loop.js:22
const messages = [{ role: 'user', content: userPrompt }];
```

This is the only section that changes per turn. Clean separation: the volatile part is isolated to one slot.

**The missing section — few-shot examples.** Section 3 is empty in buffr. There are no worked examples anywhere in the assembled prompt. On a 9B model that matters more than it would on a frontier model — examples constrain output harder than instructions do. That's the whole of [08-few-shot.md](08-few-shot.md).

### Move 3 — the principle

One job per section, named explicitly, owned by exactly one part of the system. The anatomy isn't bureaucracy — it's what lets you reason about each piece in isolation. When something drifts, a clean anatomy tells you *which section* drifted. A prompt that mashes role, context, and question into one blob gives you nothing to bisect.

## Primary diagram

The full anatomy with owners labeled — the recap to return to.

```
  buffr's prompt anatomy — section · owner · lifecycle

  ┌─ System prompt ──────────────┐ owner: aptkit RagQueryAgent
  │  role + search-first +        │ lifecycle: constant
  │  ground + cite + refuse       │ (BASE_SYSTEM, rag-query-agent.js:12)
  ├─ Context injection ──────────┤ owner: buffr (loadProfile)
  │  # About the person…          │ lifecycle: per-user constant
  │  <me.md profile>              │ (injectProfile, prepended)
  ├─ Few-shot examples ──────────┤ owner: — (ABSENT)
  │  (none)                       │ lifecycle: —
  ├─ User message ───────────────┤ owner: buffr (session.ask)
  │  "<the question>"             │ lifecycle: per-call
  └──────────────────────────────┘
       + appended by provider: the tool catalog (see 02)
```

## Elaborate

The four-section anatomy is the through-line of Anthropic's and OpenAI's prompt guides — system vs user role separation is the first thing both teach. The reason it's load-bearing in production and not just tidy: the constant/per-call split maps directly onto **prefix caching** (the stable prefix is cacheable; see [04](04-token-budgeting.md)) and onto **trust** (system instructions outrank user content; see [12](12-prompt-injection-defense.md)). buffr's prompt happens to be assembled by three owners rather than written in one place — that's the normal production shape, and [00-overview.md](00-overview.md) walks the assembly.

## Interview defense

**Q: Walk me through the anatomy of the prompt this system sends.**

Four sections, stable-to-volatile: system prompt (role + grounding rules, constant), context injection (the user profile, per-user), few-shot examples (absent here), user message (the question, per-call). The load-bearing move is the constant/per-call split — system text never sees the question, so each piece is reasoned about alone.

```
  stable ──────────────────────────► volatile
  [ system ] [ profile ] [ —shots ] [ question ]
   constant   per-user    absent      per-call
```

Anchor: *"In buffr, those four sections aren't in one file — they're assembled across three owners. The system prompt is `BASE_SYSTEM` in aptkit, the profile is prepended by `injectProfile`, the question is the lone user turn. The few-shot slot is empty, which is the first thing I'd add for a 9B model."*

## See also

- [00-overview.md](00-overview.md) — the three-owner assembly the anatomy maps onto
- [02-structured-outputs.md](02-structured-outputs.md) — the fifth contribution: the tool catalog the provider appends
- [04-token-budgeting.md](04-token-budgeting.md) — why stable-on-top is also the cache ordering
- [08-few-shot.md](08-few-shot.md) — the missing section, built out
- [12-prompt-injection-defense.md](12-prompt-injection-defense.md) — why the ordering is also a trust ordering
