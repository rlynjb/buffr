# Structured-output reprompt (validate, then retry stricter)

**Industry name(s):** Structured generation / JSON-mode with validation retry / reprompt-on-parse-failure · *Industry standard*

---

## Zoom out, then zoom in

I have shipped features that depend on structured output, and every one
broke at least once because the model returned schema-conformant JSON
*inside a markdown code fence* as a courtesy, and the parser choked. The
production answer is never "tell the model to output JSON." It's
"generate, extract the JSON, validate it, and on failure retry once with
a stricter nudge — and strip the fence either way." aptkit ships exactly
that loop. buffr's RAG path doesn't call it yet — but it's the same
skeleton as the tool-call emulation buffr *does* run, so it's worth
walking, and the audit flags it honestly as library-present /
buffr-not-yet-wired.

```
  Zoom out — where structured generation would sit

  ┌─ Service (a structured capability) ──────────────────────────┐
  │  generateStructured(...)  ★ THIS GUIDE ★                      │
  │   present in @aptkit/runtime; NOT called by buffr's ask path  │
  └───────────────────────────┬──────────────────────────────────┘
                              │ generate → extract → validate → retry
  ┌─ Provider (Gemma) ────────▼──────────────────────────────────┐
  │  one model.complete per attempt                              │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is a **bounded retry around a validate** — generate,
parse-and-validate, and if it fails, append "Return ONLY valid JSON - no
prose, no markdown fences" to the user message and try once more. The
fence-strip happens on every attempt, not just the retry. It's the
tool-call emulation skeleton (→ [`03`](03-tool-call-emulation-prompt.md))
generalized to any schema.

---

## Structure pass

**Layers.** Caller (defines a `validate` fn) → `generateStructured`
(orchestrates attempts) → `parseValidatedJson` (extract + validate) →
provider (one completion per attempt).

**Axis — *who is trusted to produce valid JSON, and when does that flip
to "force it"?*** Trace it:

```
  axis: trust the model to emit valid JSON?

  ┌─ attempt 1 ─────────┐  base prompt           → TRUST (model is polite, may fence)
  └─────────┬───────────┘
  ┌─ parse/validate ────┐  fence-strip + schema  → VERIFY (don't trust, check)
  └─────────┬───────────┘
  ┌─ attempt 2 ─────────┐  + strict suffix       → COERCE (stop trusting, demand)
  └─────────┬───────────┘
  ┌─ give up ───────────┐  return {ok:false}     → FAIL LOUD (emit error event)
  └─────────────────────┘
```

**The seam — the validate boundary.** On one side, raw model text you
can't trust. On the other, a typed value you can. `parseValidatedJson`
owns the flip, and it's where the courteous-fence bug is caught. The
strict-suffix retry exists precisely because the model sometimes won't
cross that seam on the first try.

---

## How it works

### Move 1 — the mental model

Think of form validation with one auto-retry: submit, server rejects,
the form re-submits once with a "no really, plain text only" flag, then
gives up and shows an error. That's the shape — `maxAttempts` defaults
to 2 (`structured-generation.js:10`), so it's one generate plus at most
one stricter retry.

```
  The pattern — bounded validate-retry

  attempt 1: base messages ──► model ──► parseValidatedJson
                                              │
                                       ok? ───┴─── fail?
                                        │            │
                                   return value   attempt 2:
                                                  base + STRICT SUFFIX ──► model
                                                              │
                                                       ok? ───┴─── fail?
                                                        │            │
                                                   return value   {ok:false} + error event
```

### Move 2 — the walkthrough

**Generate, attempt 1.** `structured-generation.js:14-25`. First attempt
uses `baseMessages` untouched — you give the model the clean prompt and
trust it. `model.complete` runs through the same Gemma provider, so the
output is whatever Gemma returns as text.

**Extract — strip the fence.** This is the bug-defense.
`parseValidatedJson` → `parseAgentJson` (`json-output.js:1-19`):

```
  parseAgentJson — the courteous-fence defense (json-output.js:2-3)

  fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)   ← strip ```json … ```
  candidate = (fence ? fence[1] : text).trim()
  try { return JSON.parse(candidate) }                  ← happy path
  catch { /* fall through */ }
  // bounded substring scan: first { or [ … last } or ]
  start = min(indexOf('{'), indexOf('['))               ← find the object/array
  end   = max(lastIndexOf('}'), lastIndexOf(']'))
  return JSON.parse(candidate.slice(start, end+1))      ← rescue JSON buried in prose
```

The fence regex on line 2 is the entire reason this survives a polite
model. Gemma, told to output JSON, often returns ` ```json\n{...}\n``` `
because it's been trained that JSON belongs in code fences. Without the
strip, `JSON.parse` sees the backticks and throws. The substring scan is
the second line of defense — if the model wrapped the JSON in prose
("Sure! Here's the JSON: {...}"), it scoops out the brace-to-brace
slice.

**Validate.** `parseValidatedJson:31` calls the caller's `validate(parsed)`.
This is schema enforcement — the caller decides what shape is acceptable
(the aptkit agents pass their own validators, e.g. `validateQueryAnswer`).
A parse success that fails the schema is still a failure; the retry fires.

**Retry, attempt 2 — stricter.** On failure with attempts left,
`appendStrictSuffix` (`structured-generation.js:58-69`) walks the
messages backward, finds the last user string, and appends the
`DEFAULT_STRICT_SUFFIX` (`:3`): "\n\nReturn ONLY valid JSON - no prose,
no markdown fences." The model gets a second, blunter chance.

```
  appendStrictSuffix — the second-chance nudge (lines 60-67)

  for index from end → 0:
    if message is user AND content is string:
      content += "\n\nReturn ONLY valid JSON - no prose, no markdown fences."
      return                              ← patch the last user turn
  // no user string found → push the suffix as its own message
```

**Give up loudly.** `structured-generation.js:47-49`: after
`maxAttempts`, return `{ ok: false, error, attempts }` and emit an
`error` trace event. It fails *loud*, not silent — the `attempts` array
carries every raw text and error so you can debug the regression. This
is the "log the schema-fail rate" discipline made concrete.

### Move 3 — the principle

Structured output is **never** "ask for JSON and hope." It's
generate → strip → validate → retry-once-stricter → fail loud, with the
fence-strip on every attempt because the courteous model is the common
case, not the edge case. The retry is bounded (2 attempts) because an
unbounded retry on a model that *can't* produce the schema is an infinite
loop with a bill attached. The discipline that separates demo from
production is the validate-and-log, not the prompt.

---

## Primary diagram

```
  Structured-output reprompt — full loop (generateStructured:9-50)

  ┌─ caller: { model, system, userPrompt, validate, retry } ─────┐
  └───────────────────────────┬──────────────────────────────────┘
                              │ maxAttempts = max(1, retry.maxAttempts ?? 2)
  ┌─ attempt loop ────────────▼──────────────────────────────────┐
  │  msgs = attempt 1 ? base : base + STRICT_SUFFIX               │
  │  resp = model.complete({ system, msgs })                     │
  │  parsed = parseValidatedJson(text, validate)                 │
  │    └ parseAgentJson: strip ```json``` fence → JSON           │
  │       └ fallback: brace/bracket substring scan               │
  │    └ validate(parsed)  ← caller's schema                     │
  │  parsed.ok ? return {ok:true, value} : record attempt, loop  │
  └───────────────────────────┬──────────────────────────────────┘
                              │ attempts exhausted
  ┌─ fail loud ───────────────▼──────────────────────────────────┐
  │  emit error event · return {ok:false, error, attempts}       │
  └───────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use case in buffr: not yet wired.** buffr's `session.ts` ask path
returns the RAG agent's free-prose answer (`:60-71`, via
`agent.answer(question)` at `:62`); it never calls
`generateStructured`. The honest finding (audit lens 5): the
schema-validated structured-output loop is **present in the consumed
library** and is the natural home for any future buffr capability that
needs a typed result (an intent classifier, a tag extractor, a
structured eval verdict) — but today buffr exercises only the *tool-call*
form of structured output (→ [`03`](03-tool-call-emulation-prompt.md)),
not the schema-validated form.

What buffr **does** exercise from this file's machinery is the
fence-strip: `parseAgentJson` (`json-output.js`) is on buffr's live path
because `parseToolCall` (`gemma-provider.js:108`) calls it for every tool
call. So the courteous-fence defense is active in buffr; the full
validate-retry loop is not.

**The retry orchestration — `structured-generation.js:14-46`:**

```
  generateStructured  (lines 16-44)

  const messages = attempt === 1 ? baseMessages
                 : appendStrictSuffix(baseMessages, strictSuffix);  ← stricter on retry
  response = await options.model.complete({ system, messages, … });
  const parsed = parseValidatedJson(rawText, options.validate);     ← strip+parse+schema
  if (parsed.ok) return { ok: true, value: parsed.value, … };       ← success exits
  attempts.push({ attempt, rawText, error: parsed.error });         ← record for debugging
  if (attempt < maxAttempts) emitWarning(…, `validation failed…`);  ← observe the fail rate
       │
       └─ the attempts[] array is the "log your schema-fail rate" discipline:
          every raw text + error is retained for the caller to inspect
```

**The fence-strip on buffr's live path — `json-output.js:1-19`** (via
`parseToolCall`): line 2's `/```(?:json)?…```/i` regex is what stops a
fenced tool call from breaking buffr's agent loop today.

---

## Elaborate

The canonical reference is OpenAI's JSON mode / `response_format` and the
broader "structured outputs" guidance — but the cross-provider truth is
that *enforcement at the boundary* matters more than the provider flag.
A provider can guarantee JSON syntax and still hand you JSON that fails
your schema; the `validate(parsed)` step (`json-output.js:31`) is what
catches that. aptkit's loop is provider-neutral on purpose — the
docstring (`structured-generation.js:4-8`) calls it "the provider-neutral
version of Dryrun's on-device JSON pipeline," which is the reader's own
dryrun project (Gemini Nano on-device). Same pattern, two of the reader's
codebases.

The bug this file is named for — courteous markdown fences — is the one
that survives every model upgrade and bites teams that trust the
provider flag. The defense is one regex (`json-output.js:2`), and it's
cheap insurance. Skipping it is the classic "worked in the demo, broke
in prod when the model felt chatty" failure.

Why buffr hasn't wired the full loop: its single capability (RAG Q&A)
genuinely wants free prose, not a schema — structured output is the
wrong tool for open-ended answer generation (audit lens 9's cousin
reasoning). The loop earns its place the moment buffr adds a *typed*
capability. Until then, naming it as available-but-unused is the honest
call.

---

## Interview defense

**Q: You ask a model for JSON. It returns valid JSON wrapped in a
markdown fence. What happens, and how do you defend against it?**

`JSON.parse` throws on the backticks unless you strip the fence first.
The defense is `parseAgentJson` (`json-output.js:2`): a
`/```(?:json)?…```/i` regex strips the fence before parsing, with a
brace-to-brace substring scan as a fallback for JSON buried in prose.
Then the validate-retry: on a schema failure, retry once with "Return
ONLY valid JSON - no prose, no markdown fences"
(`structured-generation.js:3`), bounded to 2 attempts, then fail loud
with the raw attempts retained for debugging. The load-bearing part
people forget: **the fence-strip runs on every attempt, not just the
retry** — the polite model is the common case.

```
  ```json {…} ```  ──strip fence──►  {…}  ──validate──►  typed value
        ▲                                                    │
        └──── retry w/ strict suffix if validate fails ◄─────┘
```

**Anchor:** "Structured output = strip + validate + retry-once-stricter +
fail loud; the fence-strip at `json-output.js:2` is the cheap insurance."

---

## Validate

- **Reconstruct.** Write the attempt loop from memory: what's different
  between attempt 1 and attempt 2 (`structured-generation.js:16`)?
- **Explain.** Why does `parseAgentJson` strip a markdown fence
  (`json-output.js:2`) before `JSON.parse`? What model behavior is that
  defending against, and is it on buffr's live path? (Yes — via
  `parseToolCall`.)
- **Apply.** You add an intent-classifier capability to buffr that must
  return `{intent: "..."}`. Sketch how you'd call `generateStructured`
  with a `validate` fn, and what `appendStrictSuffix` adds on retry.
- **Defend.** Argue why buffr's RAG answer path correctly does *not* use
  structured output, while a classifier would. (Open-ended prose vs
  typed verdict.)

---

## See also

- [`03-tool-call-emulation-prompt.md`](03-tool-call-emulation-prompt.md)
  — the same generate/parse/retry skeleton, applied to tool calls
- [`02-grounding-and-citation-instruction.md`](02-grounding-and-citation-instruction.md)
  — where an output-schema lock would harden grounding (and injection)
- [`audit.md`](audit.md) — lens 5, the library-present / buffr-not-wired finding

---

Updated: 2026-06-24 — Re-pointed the "returns free prose" reference from
the deleted `ask-cmd.ts` to the `session.ts` ask path
(`agent.answer(question)` at `:62`). The validate-retry loop is still
library-present / buffr-not-wired — unchanged.
