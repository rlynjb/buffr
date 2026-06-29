# Three-owner prompt assembly

*Prompt composition / system-prompt layering — Project-specific (the assembly is
buffr-specific; the layering pattern is industry-standard).*

## Zoom out, then zoom in

You've shipped AdvntrCue, so you already hold the RAG shape: retrieve → augment →
generate. What's different here is *who writes the prompt string*. In AdvntrCue you
owned the system prompt end to end. In buffr you own one third of it, and the most
important third — the part that makes tool calling work — you don't own at all.

```
  Zoom out — where prompt assembly sits in buffr

  ┌─ CLI layer (this repo) ──────────────────────────────────┐
  │  chat.tsx  →  session.ask(q)                              │
  └───────────────────────────┬──────────────────────────────┘
                             │ question string
  ┌─ buffr session (this repo) ─▼────────────────────────────┐
  │  ★ loadProfile + new RagQueryAgent({ profile }) ★         │ ← we are here
  │    Owner 1: hands a profile string to aptkit             │
  └───────────────────────────┬──────────────────────────────┘
                             │ profile + question
  ┌─ aptkit library (node_modules, not editable) ─▼──────────┐
  │  Owner 2: injectProfile(BASE_SYSTEM, profile)            │
  │  Owner 3: Gemma provider appends tool catalog text       │
  └───────────────────────────┬──────────────────────────────┘
                             │ final messages[]
  ┌─ Provider ──────────────────▼────────────────────────────┐
  │  Ollama /api/chat  (gemma2:9b)                            │
  └───────────────────────────────────────────────────────────┘
```

Zoom in: the concept is **prompt assembly across ownership boundaries.** The
question it answers — *when a bug appears in the final prompt, whose layer is it?*
— is the one that saves you the two-week debug the persona warns about.

## Structure pass

Trace one axis — **who controls this slice of the prompt string?** — down the
layers, and watch where it flips.

```
  Axis: "who controls this part of the prompt text?"

  ┌─ buffr ───────────┐  controls: WHICH profile, WHICH model config
  │  session.ts       │  (the inputs, not the template)
  └─────────┬─────────┘
          ══╪══  seam 1: buffr → aptkit  (control flips: buffr picks
            │              inputs, aptkit owns the template + ordering)
  ┌─ aptkit agent ────▼┐ controls: BASE_SYSTEM text, profile POSITION,
  │  rag-query-agent  │  the "cite sources" instruction
  └─────────┬─────────┘
          ══╪══  seam 2: agent → provider  (control flips: agent hands a
            │              system string, provider rewrites it)
  ┌─ Gemma provider ──▼┐ controls: tool-catalog text, the JSON demand,
  │  gemma-provider   │  the retry nudge
  └───────────────────┘
```

Two load-bearing seams. **Seam 1** is where buffr's responsibility ends: you pass
a profile, you don't decide where it goes or what surrounds it. **Seam 2** is the
surprising one — the provider doesn't just *send* the system string, it *rewrites*
it, appending the entire tool catalog. The capability that defines the app is born
on the far side of a seam you can't edit.

## How it works

### Move 1 — the shape

The mental model is string concatenation with a fixed precedence — like building a
CSS cascade where each layer can only append, never reach back and edit the layer
before it. Each owner takes the string it's handed and prepends or appends its own
block.

```
  Pattern — append-only assembly, three owners

  Owner 1 (buffr):   profile  ─┐
                               │  hands (profile, question) to →
  Owner 2 (agent):   [profile] + [BASE_SYSTEM]   = withProfile
                               │  hands (withProfile, toolSchemas) to →
  Owner 3 (provider):[withProfile] + [tool catalog text + JSON demand]
                               │
                               ▼
                     final system string → Ollama
```

The invariant: **a later owner never edits an earlier owner's block, only frames
it.** That's what makes the assembly debuggable — each block has exactly one author.

### Move 2 — the walkthrough

**buffr loads the profile and constructs the agent (Owner 1).** This is your whole
job in the assembly. `loadProfile` reads the most-recent `me.md`-style row from
Postgres; `createChatSession` passes it straight into the agent constructor.

```ts
// src/profile.ts:4 — buffr owns the INPUT, not the template
export async function loadProfile(pool, appId): Promise<string> {
  const { rows } = await pool.query(
    'select content from agents.profiles where app_id = $1 order by updated_at desc limit 1', [appId]);
  return rows[0]?.content ?? '';   // '' if none — assembly still works, no profile block
}

// src/session.ts:47,57
const profile = await loadProfile(pool, cfg.appId);
const agent = new RagQueryAgent({ model, tools, profile, trace });  // profile crosses seam 1
```

Note the boundary condition: an empty profile is fine. `injectProfile` is only
called `if (options.profile)` (`rag-query-agent.js:29`), so no profile means the
prompt is just `BASE_SYSTEM` + tools. buffr can't break aptkit's template by
handing it a bad profile — worst case it hands `''`.

**aptkit injects the profile, then renders the template (Owner 2).** Across seam 1,
control flips. aptkit decides the *position* (`start` — prepended) and the
*heading* (`# About the person you are assisting`), neither of which buffr can
influence.

```ts
// rag-query-agent.js:27-32
const template = options.prompt ?? DEFAULT_SYSTEM_TEMPLATE;   // BASE_SYSTEM
const withProfile = options.profile
  ? injectProfile(template, options.profile, { position: 'start', heading: PROFILE_HEADING })
  : template;
this.system = renderPromptTemplate(withProfile, {});   // resolve {placeholders}, none here
```

```ts
// profile-injector.js:18-22 — pure string in/out, the actual concatenation
const block = heading ? `${heading}\n${profileText}` : profileText;
return position === 'end' ? `${systemTemplate}\n\n${block}`
                         : `${block}\n\n${systemTemplate}`;   // start = profile FIRST
```

Here's the production smell worth naming: the comment says *"inject then render"* so
that `{schema}`-style placeholders survive injection. buffr's profile is plain
prose with no placeholders, so it's safe — but if a future `me.md` ever contained a
literal `{` , `renderPromptTemplate` would try to resolve it as a template variable.
That's a real prompt-injection-adjacent footgun living one seam away from your data.

**The provider appends the tool catalog (Owner 3).** Across seam 2, the system
string is rewritten — covered in full in
[`02-tool-call-emulation.md`](02-tool-call-emulation.md). The one-line version: the
provider takes aptkit's system string and appends `"You can call the following
tools:"` + every tool serialized as JSON + a demand to reply with a JSON object.

```
  Layers-and-hops — the profile string's journey

  ┌─ buffr ───────┐ hop 1: profile string      ┌─ aptkit agent ──┐
  │ session.ts    │ ─────────────────────────► │ injectProfile    │
  └───────────────┘                            └────────┬─────────┘
                              hop 2: "[profile]\n\n[BASE_SYSTEM]"
                                                        ▼
                                              ┌─ Gemma provider ─┐
                                              │ buildSystemText  │
                            hop 3: + tool catalog text + JSON demand
                                              └────────┬─────────┘
                              hop 4: final system string ▼
                                                  Ollama /api/chat
```

### Move 3 — the principle

When a prompt is assembled across libraries, **the debugging question is never
"what's wrong with the prompt" — it's "which owner's block is wrong."** Map the
seams first. In buffr, a personalization bug is Owner 1 (wrong profile row), a
grounding/citation bug is Owner 2 (`BASE_SYSTEM`), and a tool-calling bug is Owner 3
(the catalog text or the parse-back) — and Owners 2 and 3 are `node_modules` you
fix by upgrading the package, not editing a string.

## Primary diagram

```
  Full assembly — three owners, two uneditable seams

  OWNER 1 (buffr, editable) ──── seam 1 ──── OWNER 2 (aptkit) ── seam 2 ── OWNER 3 (Gemma)
  ┌────────────────────────┐               ┌──────────────────┐         ┌─────────────────┐
  │ loadProfile()          │  profile str  │ injectProfile()  │ sys str │ buildSystemText │
  │ new RagQueryAgent()    │ ────────────► │ + BASE_SYSTEM    │ ──────► │ + tool catalog  │
  │ pick model + maxTokens │               │ "cite sources"   │         │ + JSON demand   │
  └────────────────────────┘               └──────────────────┘         └────────┬────────┘
   controls INPUTS                          controls TEMPLATE             controls TOOL TEXT
                                                                                  ▼
                                                                         Ollama gemma2:9b
```

## Elaborate

This append-only, multi-owner shape is the norm once you consume an agent
framework (LangChain, the Anthropic SDK's agent helpers, aptkit). The framework
owns the system-prompt template and the provider adapter; you own the inputs. The
discipline the spec teaches — *one job per section, named explicitly* — is enforced
here by the package boundary itself: you literally cannot smear buffr logic into
`BASE_SYSTEM` because it's in `node_modules`. That's a feature. The cost is that
fixing a prompt bug in Owner 2 or 3 means a version bump, not an edit — which is
exactly why `study-ai-engineering`'s provider-abstraction discussion matters.

## Interview defense

**Q: "Where does the system prompt come from in this app?"**
Don't say "a string in the code." The honest answer: it's assembled across three
owners — buffr loads the profile, aptkit prepends it to a constant `BASE_SYSTEM`
that says *call search first, ground, cite*, and the Gemma provider appends the
tool catalog as text. The surprising part is the third hop: the provider *rewrites*
the system string to emulate tool calling, because Gemma 2 9B has no native tool
API.

```
  buffr (profile) → aptkit (BASE_SYSTEM) → Gemma (tool text) → Ollama
   editable         node_modules          node_modules
```

Anchor: *"I own one hop; the load-bearing hop is the one I don't own."*

## See also

- [`02-tool-call-emulation.md`](02-tool-call-emulation.md) — Owner 3 in full
- [`03-profile-injection-as-personalization.md`](03-profile-injection-as-personalization.md) — Owner 1→2 in full
- [`04-grounding-and-citation-instruction.md`](04-grounding-and-citation-instruction.md) — what Owner 2's `BASE_SYSTEM` actually says
- `study-agent-architecture` — the loop that drives these owners per turn
