# Structured-output reprompt

*Validated JSON generation / parse-validate-retry — Industry standard (the
production "generate → validate → retry with a stricter prompt" loop).*

> Honest framing up front: this pattern lives in aptkit and is **not on buffr's
> chat hot path.** `createChatSession` never calls `generateStructured` — the chat
> agent uses the emulated tool-call path ([file 02](02-tool-call-emulation.md))
> instead. This file walks it because (a) the spec's concept #2 is centrally about
> it, (b) it's the *right* shape for the answer-quality eval the audit recommends
> building, and (c) it's the machinery buffr would grow into the moment it needs a
> typed answer. It's a curriculum target with real code behind it, not a fiction.

## Zoom out, then zoom in

You've felt this bug: you ask a model for JSON, it gives you JSON *inside a markdown
fence* as a courtesy, and your `JSON.parse` throws. The production answer isn't "ask
nicer" — it's a loop: generate, try to parse-and-validate, and on failure re-prompt
once with a stricter "JSON only, no fences" suffix. aptkit ships exactly that loop.

```
  Zoom out — where structured generation sits

  ┌─ aptkit runtime (available to buffr, unused on chat path) ┐
  │  ★ generateStructured: gen → validate → retry-once ★      │ ← we are here
  └───────────────────────────┬──────────────────────────────┘
                             │ (buffr's chat path goes around this)
  ┌─ buffr chat ────────────────▼────────────────────────────┐
  │  uses emulated tool calls instead (file 02)               │
  └───────────────────────────────────────────────────────────┘
```

Zoom in: the concept is the **structured-output reprompt** — treat the model's JSON
as untrusted, validate it at the boundary, and on a parse/validation failure retry
with a stricter instruction before giving up. The question it answers: *how do you
get reliable JSON out of a model that's only mostly reliable?*

## Structure pass

One axis — **is the output trusted yet?** — flips at the validation boundary, and
the retry exists precisely to handle the "no" case once.

```
  Axis: "is this output a trusted, typed value?"

  ┌─ model.complete ──┐  output: raw text — UNTRUSTED (maybe fenced, maybe prose)
  └─────────┬─────────┘
          ══╪══ seam: parseValidatedJson  (the trust check)
  ┌─ validated ───────▼┐ ok → TRUSTED typed value, return
  │  parse + schema    │ fail → still untrusted → retry ONCE with strict suffix
  └─────────┬─────────┘          (then give up: { ok:false })
            ▼
       typed value OR explicit failure (never a silent bad parse)
```

The seam is `parseValidatedJson`. The discipline the spec hammers — *validate the
parse, don't trust the model* — is this exact boundary. What's on the far side
matters: a failure isn't an exception that crashes the turn, it's a structured
`{ ok: false, error, attempts }`, so the caller decides what to do.

## How it works — load-bearing skeleton

Kernel:

```
  Kernel — structured-output reprompt

  for attempt in 1..maxAttempts:        // default 2 = one try + one retry
    messages = attempt == 1 ? base : base + STRICT_SUFFIX
    response = model.complete(messages)
    parsed   = parseValidatedJson(response, validate)
    if parsed.ok → return { ok:true, value }
    // else loop, appending the strict suffix
  return { ok:false, error }            // exhausted: explicit failure, not a throw
```

Named by what breaks when removed:

### Part 1 — validate at the boundary (remove it: a bad parse flows downstream as "data")

The model's text is parsed *and* schema-checked in one step; only `ok` results are
trusted.

```ts
// structured-generation.js:36-41
const rawText = textFromResponse(response);
const parsed = parseValidatedJson(rawText, options.validate);   // parse + validate together
if (parsed.ok) {
  attempts.push({ attempt, rawText });
  return { ok: true, value: parsed.value, rawText, attempts };   // typed, trusted
}
```

Drop this and a malformed-but-parseable object (right JSON, wrong shape) sails into
your code as if it were valid — the exact 5%-failure-that-takes-two-weeks the
persona warns about.

### Part 2 — the strict-suffix retry (remove it: a courteous fence is a hard failure)

On a failed attempt, the loop appends a blunt JSON-only instruction to the last user
message and tries again.

```ts
// structured-generation.js:3, 16, 58-69
const DEFAULT_STRICT_SUFFIX = '\n\nReturn ONLY valid JSON - no prose, no markdown fences.';
// …
const messages = attempt === 1 ? baseMessages : appendStrictSuffix(baseMessages, strictSuffix);
// appendStrictSuffix finds the last user message and concatenates the suffix onto it
```

That suffix string is the spec's headline bug, fixed: *"no markdown fences"* exists
because the #1 cause of structured-output failure is a courteous model wrapping
perfectly good JSON in \`\`\`json. The first attempt asks normally; the retry stops
being polite about it. One retry, not infinite — `maxAttempts` defaults to 2
(`structured-generation.js:10`).

### Part 3 — explicit failure, not an exception (remove it: the caller can't recover)

Exhausting retries returns a value, not a throw — and model-call errors are caught
and returned too.

```ts
// structured-generation.js:47-49
const error = attempts[attempts.length - 1]?.error ?? 'structured generation failed';
emitError(options, `structured generation failed after ${maxAttempts} attempt${maxAttempts === 1 ? '' : 's'}: ${error}`);
return { ok: false, error, attempts };       // structured failure with the full attempt log
```

The `attempts` array is the observability hook — every raw text and every validation
error is captured, so when this fails in production you can see exactly what the
model returned each time. That's the spec's "log the schema-fail rate to your
metrics dashboard" made concrete.

```
  Execution trace — courteous-fence failure, recovered

  attempt 1: model returns "```json\n{\"intent\":\"search\"}\n```"
    parseValidatedJson → (depends on validator) fail or ok
    if fail → attempts=[{1, error:"…"}], loop
  attempt 2: base + "Return ONLY valid JSON - no prose, no markdown fences."
    model returns "{\"intent\":\"search\"}"
    parseValidatedJson → ok → return { ok:true, value:{intent:"search"} }  ✓
```

### Skeleton vs. hardening

Kernel: validate-at-boundary + one strict retry + explicit failure. Hardening: the
`attempts` log, the per-attempt warning/error trace emissions (`emitWarning`/
`emitError`), abort-signal handling. Strip hardening and it still produces trusted
JSON or an honest failure; strip the kernel and you're back to trusting raw model
text.

## Move 2.5 — current state vs. future state

This is the one concept where Phase A / Phase B matters, because the pattern is
built but dormant on buffr's chat path.

```
  Comparison — buffr chat today vs. if it needed typed answers

  ┌─ Phase A: today (chat path) ──────┐   ┌─ Phase B: typed-answer path ──────┐
  │ session.ask() → RagQueryAgent     │   │ session.ask() → generateStructured│
  │ emulated tool calls (file 02)     │   │ schema-validated JSON answer      │
  │ final answer = free prose         │   │ final answer = { answer, sources }│
  │ no schema on the OUTPUT           │   │ parse+validate+retry on output    │
  └───────────────────────────────────┘   └───────────────────────────────────┘
           what carries over: the model, the provider, the trace sink.
           what changes: one call site swaps RagQueryAgent for generateStructured.
```

The takeaway the spec wants: *what doesn't have to change.* The provider, the
context guard, the trace persistence all stay. Adopting validated structured output
for buffr's answers is a call-site swap, not a rewrite — because aptkit already
factored the loop out.

## Primary diagram

```
  Structured-output reprompt — generate, validate, retry once

  ┌─ generateStructured ─────────────────────────────────────────┐
  │  attempt 1: model.complete(base)                             │
  │       │ raw text                                             │
  │  parseValidatedJson ──ok──► return { ok:true, value }        │
  │       │ fail                                                 │
  │  attempt 2: model.complete(base + "ONLY JSON, no fences")    │
  │       │ raw text                                             │
  │  parseValidatedJson ──ok──► return { ok:true, value }        │
  │       │ fail                                                 │
  │  return { ok:false, error, attempts[] }  (explicit, traced)  │
  └───────────────────────────────────────────────────────────────┘
```

## Elaborate

This is the provider-neutral version of the on-device JSON pipeline the source
comment cites ("Dryrun's on-device JSON pipeline" — `structured-generation.js:6`),
which connects directly to your dryrun project in `me.md`'s portfolio: generate,
extract JSON, validate, retry once strict. The reference for the discipline is the
spec's own framing — the gap between "use JSON mode" (blog) and "validate the parse
AND retry stricter AND log the fail rate" (production) is the gap this file's three
parts close. Where a provider has *native* structured output (OpenAI
`response_format`, Anthropic tool-schema enforcement), you lean on that first and
keep this loop as the validation-and-retry wrapper around it. With a local Gemma
that has neither, this prompt-level loop *is* the enforcement.

## Project exercises

### PE-1 — Typed, validated chat answers

- **What to build:** a `session.askStructured()` that routes through
  `generateStructured` with a schema like `{ answer: string, sources: string[] }`,
  validating that `sources` are real returned `docId`s.
- **Why it earns its place:** turns `audit.md §2`'s off-path pattern into a live
  buffr capability and gives the citation contract from [file 04](04-grounding-and-citation-instruction.md)
  actual *enforcement* — the gap that file names honestly.
- **Files to touch:** `src/session.ts` (new method), a schema module, reuse the
  existing `model` and `trace`.
- **Done when:** an answer with a hallucinated source fails validation and triggers
  the strict retry, and the `attempts` log is persisted via the trace sink.
- **Estimated effort:** one day.

## Interview defense

**Q: "How do you get reliable JSON out of a model that mostly cooperates?"**
You stop trusting it and wrap it in a loop: generate, parse *and* schema-validate at
the boundary, and on failure retry exactly once with a stricter suffix — literally
"return only JSON, no markdown fences," because the #1 failure is a courteous model
fencing good JSON. Exhausting retries returns a structured `{ ok:false }` with the
full attempt log, never a silent bad parse. The detail that signals production
experience: the retry is *gated and bounded* (one extra attempt), and every attempt
is logged so you can watch the schema-fail rate.

```
  generate → validate ──ok──► trusted value
                  └─fail─► retry(+ "ONLY JSON, no fences") → validate → value | {ok:false}
```

Anchor: *"Validate at the boundary, retry once stricter, fail explicitly — never
trust raw model text as data."*

## See also

- [`02-tool-call-emulation.md`](02-tool-call-emulation.md) — the same parse-back-and-retry shape, applied to tool calls
- [`04-grounding-and-citation-instruction.md`](04-grounding-and-citation-instruction.md) — the unenforced citation this pattern could enforce
- [`05-bounded-synthesis-nudge.md`](05-bounded-synthesis-nudge.md) — the other "retry with a stricter prompt" mechanic in the loop
- `study-ai-engineering` — evals and the production-serving seam this hands off to
