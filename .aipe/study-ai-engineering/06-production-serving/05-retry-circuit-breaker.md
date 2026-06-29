# Retry & Circuit Breaker

*Industry name: retry with backoff / circuit breaker / graceful degradation. Type: **Language-agnostic** resilience pattern.*

## Zoom out, then zoom in

Every call to a dependency can fail, and the two failure shapes need opposite responses. A *transient* failure (a blip) wants a retry. A *persistent* failure (the dependency is down) wants you to *stop calling* — a circuit breaker — so you don't pile retries onto a corpse. Here's where this machinery sits in buffr, and the picture is genuinely mixed: one narrow retry exists, the broad ones don't.

```
buffr resilience stack — one narrow retry, broad ones missing
┌────────────────────────────────────────────────────────────────┐
│ GemmaModelProvider                                              │
│   maxToolCallAttempts (default 2)  ◀ ★ ONE retry, on bad JSON   │  PARTIAL
│   defaultHttpTransport: throws on !res.ok  ◀ no backoff retry   │  (empty)
├────────────────────────────────────────────────────────────────┤
│ session.ask()                                                   │
│   memory.remember() in try/catch (swallow)  ◀ graceful degrade  │  (degrade, not retry)
│   ◀ ★ NO circuit breaker for Ollama-down                        │  (empty)
└────────────────────────────────────────────────────────────────┘
```

There is exactly one retry, and it retries exactly one thing — a botched tool-call JSON, once. **This is Partial: a narrow retry and a graceful-degradation path exist; exponential backoff on HTTP failure and a circuit breaker do not.** This file is precise about which mechanism covers which failure.

## Structure pass — trace *each failure type* to its response

Pick one axis: **for each way a dependency can fail, what does buffr do?** Trace it.

```
failure → response (buffr today)
  failure type                          buffr's response
  ─────────────────────────────────────────────────────────────────
  Gemma returns botched tool-call JSON   retry ONCE with RETRY_NUDGE   ◀ covered (narrow)
  memory write fails                     swallow, return answer anyway  ◀ graceful degrade
  Ollama HTTP 500 / connection refused   throw, propagate to UI         ◀ NOT covered
  Ollama down for minutes                throw EVERY turn, no breaker    ◀ NOT covered
  ─────────────────────────────────────────────────────────────────
  the diagonal: one cell retries, one degrades, two just throw
```

There's no seam between transient and persistent HTTP failure — that's the gap. A resilient system retries the blip and trips a breaker on the outage; buffr does neither for the Ollama HTTP path. The concrete consequence: if Ollama hiccups for one request, buffr surfaces a raw error to the user instead of retrying the blip; if Ollama is down for ten minutes, every single turn throws the same error with the same latency, because nothing remembers that the last twenty calls failed.

## How it works

### Move 1 — the mental model: retry handles blips, the breaker handles outages

Two mechanisms, two jobs, and they compose. **Retry with backoff** assumes the failure is transient: try again after a growing delay, a bounded number of times. **Circuit breaker** assumes that *if enough retries fail*, the dependency is actually down — so it *opens*, failing fast without calling, then periodically *half-opens* to test recovery. Retry is optimism with a budget; the breaker is the pessimism that stops optimism from making an outage worse.

```
the two mechanisms, composed
  call ──▶ [ breaker CLOSED? ] ──no──▶ fail fast (don't even try)   ◀ outage
              │ yes
              ▼
         [ retry with backoff: try, wait 1s, try, wait 2s, ... up to N ]
              │ all fail
              ▼
         record failure ──▶ enough failures ──▶ breaker OPENS  ◀ stop the bleeding
```

### Move 2 — the moving parts

#### Bridge: it's HTTP retry-on-`503` with backoff, plus a fuse that blows

You've written client retry: catch a `503`, wait, try again, give up after a few tries. And you know a fuse — it blows to protect the circuit instead of letting it overheat. The breaker is that fuse for a software dependency. The terminology lead is **the retry budget (`maxToolCallAttempts`)** — buffr's one real retry budget, and it's worth seeing exactly how narrow it is.

#### What buffr HAS, #1: the narrow retry — `maxToolCallAttempts`

`GemmaModelProvider` retries *once* when the model returns a malformed tool call, nudging it to fix the JSON (`gemma-provider.ts:49,57,62–67,86`):

```ts
// gemma-provider.ts:49
this.maxToolCallAttempts = Math.max(1, options.maxToolCallAttempts ?? 2);
// ...
const maxAttempts = wantsTool ? this.maxToolCallAttempts : 1;   // ← only retries when a tool is wanted
for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
  const messages = attempt === 0
    ? baseMessages
    : [...baseMessages, { role: 'user', content: RETRY_NUDGE }];   // ← corrective nudge on retry
  // ...
  if (wantsTool) {
    const call = parseToolCall(raw);
    if (call) return /* success */;
    if (looksLikeToolAttempt(raw)) continue;   // ← retry ONLY if it looked like a botched call
  }
  break;
}
```

```
maxToolCallAttempts — the one real retry, and its tight scope
  attempt 0: model replies ──▶ parseToolCall?
                                ├─ valid  ──▶ done
                                └─ botched (has '{') ──▶ attempt 1 + RETRY_NUDGE
  attempt 1: model replies ──▶ parseToolCall?
                                ├─ valid  ──▶ done
                                └─ still botched ──▶ fall back to TEXT (give up)
  scope: retries a PARSE failure, once. NOT an HTTP failure. NOT exponential.
```

Be exact about what this is and isn't. It retries a *semantic* failure (the model produced unparseable JSON), not a *transport* failure. There's no delay between attempts — no backoff. It's capped at one extra try by default. It is a real, deliberate retry, but it covers exactly one failure mode: a fumbled emulated-tool-call.

#### What buffr HAS, #2: graceful degradation — the best-effort memory write

The memory write is wrapped in a swallowing try/catch so a memory failure never costs the user their answer (`session.ts:64–69`):

```ts
// src/session.ts:64
// Best-effort: a memory-write failure must not lose the answer the user has.
try {
  await memory.remember({ conversationId, question, answer });
} catch {
  // swallow: memory is best-effort, the turn already succeeded
}
return answer;
```

```
graceful degradation — degrade, don't retry
  answer computed ──▶ memory.remember()
                       ├─ ok    ──▶ remembered
                       └─ fails ──▶ swallow, return answer anyway   ◀ user keeps their answer
  NOTE: this is NOT retry. it gives up immediately and degrades. correct choice here.
```

This is graceful degradation, not retry — and the distinction matters. Memory is non-critical: a missed memory write loses *future relevance*, not *the current answer*. So the right move is to give up instantly and degrade, exactly as buffr does. Retrying here would risk the answer for a non-essential side effect. Good call.

#### What buffr LACKS: backoff on HTTP failure, and a breaker

The transport throws on any non-OK response and never retries (`gemma-provider.ts:210–212`):

```ts
// gemma-provider.ts:210
if (!res.ok) {
  throw new Error(`ollama HTTP ${res.status}: ${await res.text()}`);   // ← no retry, no backoff
}
```

```
the gaps — the HTTP path is bare
  Ollama HTTP 500/connection refused ──▶ throw immediately ──▶ raw error to UI
       no: retry, no: backoff, no: jitter
  Ollama down for N turns ──▶ throw every turn, same latency, same error
       no: circuit breaker (nothing remembers the dependency is dead)
```

Two missing mechanisms: (1) no **backoff retry** around the Ollama HTTP call — a transient 500 or a momentary connection refusal becomes a user-facing error instead of a silent retry; (2) no **circuit breaker** — when Ollama is down, buffr keeps paying full latency to fail on every turn, because nothing tracks the failure streak and fails fast.

### Move 2.5 — current vs future

```
current (buffr today)                  │  future (after the exercises)
─────────────────────────────────────────┼──────────────────────────────────────────
tool-JSON failure: retry once (nudge)   │  unchanged — already correct
memory write: swallow + degrade         │  unchanged — already correct
Ollama HTTP blip: throw to UI           │  retry w/ exponential backoff + jitter, bounded
Ollama down: throw every turn           │  breaker opens, fails fast, half-opens to probe
```

The honest shape: buffr's *semantic* failure handling (bad JSON) and *non-critical* failure handling (memory) are both done right. Its *transport* failure handling (Ollama HTTP) is bare — the single biggest resilience gap, because Ollama is the one dependency whose outage takes the whole agent down.

### Move 3 — the principle

**Retry the blip, trip the breaker on the outage, and degrade what isn't essential.** Three responses to three failure shapes. Buffr nails two of them — it retries the model's bad JSON and degrades the non-essential memory write — and leaves the third, transport failure, uncovered. The discipline is matching the response to the failure's *nature*: optimism (retry) for transient, pessimism (breaker) for persistent, surrender (degrade) for non-critical. Retrying a persistent failure just hammers a dead dependency; breaking on a transient one needlessly drops a recoverable request.

## Primary diagram

The full resilience map: the two things buffr does right, the two gaps, and where each belongs.

```
buffr resilience — two covered cells, two gaps
  FAILURE                         RESPONSE                         STATUS
  ───────────────────────────────────────────────────────────────────────
  bad tool-call JSON ──▶ retry once + RETRY_NUDGE (gemma-provider) ── COVERED (narrow)
  memory write fails ──▶ swallow + return answer (session.ask)     ── COVERED (degrade)
  Ollama HTTP blip   ──▶ throw to UI (defaultHttpTransport)        ── GAP: needs backoff
  Ollama down        ──▶ throw every turn, full latency            ── GAP: needs breaker
  ───────────────────────────────────────────────────────────────────────
        retry = optimism (transient)    breaker = pessimism (persistent)
        degrade = surrender (non-critical)   ◀ buffr's memory write
```

## Elaborate

Why this is **Partial and not Case B**: buffr genuinely has retry and degradation logic — they're just scoped to the failures the author hit (fumbled JSON, flaky memory) rather than the failure that matters most operationally (Ollama being unreachable). That's an honest, common shape for a young system: you harden the failures you've *seen*, and the dependency outage you haven't hit yet stays bare.

The gap to close first is **backoff retry around `model.complete`**, because a transient Ollama failure is the most likely real fault — a momentary connection refusal during model load, a single 500 — and today it's a raw error in the user's face. Exponential backoff with jitter and a small cap (3 tries, say) converts most of those into invisible recoveries. The circuit breaker is the second move, for the *sustained* outage: once N consecutive calls fail, open the breaker and fail fast with a clean "Ollama appears to be down" message instead of paying full timeout latency every turn. Build the retry first; a breaker with nothing to break on is premature.

One subtlety worth carrying into an interview: the existing `maxToolCallAttempts` retry and a future HTTP-backoff retry are *different layers* and must not be conflated. The first retries because the *model's output* was wrong (a content problem); the second would retry because the *transport* failed (a network problem). Stacking them naively could multiply attempts (2 JSON retries × 3 HTTP retries = 6 Ollama calls per turn), so the backoff retry belongs *inside* the transport, beneath the tool-call loop, with its own independent budget.

## Project exercises

### Exercise: exponential backoff retry around the Ollama transport

- **Exercise ID:** [B5.10] (Phase 5, production-serving)
- **What to build:** Wrap `defaultHttpTransport` (or inject a retrying transport) with exponential backoff + jitter on transient failures (connection refused, 5xx, timeouts), bounded to a small number of attempts. Retry only *idempotent transient* failures, not 4xx. Keep this budget independent of `maxToolCallAttempts`.
- **Why it earns its place:** Ollama is the one dependency whose blip currently becomes a user-facing error. Backoff converts the most common real fault — a momentary connection issue during model load — into an invisible recovery, with no change to the agent loop above it.
- **Files to touch:** `packages/providers/gemma/src/gemma-provider.ts` (`defaultHttpTransport`) in aptkit, or — to keep buffr's changes local — inject a retrying `GemmaChatTransport` from `src/session.ts` via the provider's `chat` option (the seam is already there: `GemmaModelProviderOptions.chat`).
- **Done when:** A transport that fails the first two attempts and succeeds on the third yields a normal answer with no user-visible error, and a 4xx fails immediately without retrying — proving the retry is scoped to transient faults only.
- **Estimated effort:** Half a day. (The injectable `chat` transport makes this clean — no aptkit change required.)

### Exercise: circuit breaker for Ollama-down

- **Exercise ID:** [B5.11] (Phase 5, production-serving)
- **What to build:** A circuit breaker wrapping the model call: after N consecutive failures, open the breaker and fail fast with a clear "Ollama appears to be down — is `ollama serve` running?" message instead of paying full timeout latency. Periodically half-open to probe recovery; close on success.
- **Why it earns its place:** It turns a sustained outage from "every turn hangs then errors" into "instant, actionable error" — and it stops buffr from hammering a dead Ollama. It's the pessimism layer that the optimistic retry needs above it.
- **Files to touch:** A new `src/breaker.ts` (the breaker state machine), wrapping the model in `src/session.ts` (around `agent.answer()` or the provider). `src/cli/chat.tsx` surfaces the clean breaker-open message to the user.
- **Done when:** With Ollama stopped, the first few turns retry-then-fail, the breaker opens, and subsequent turns fail *instantly* with the actionable message; restarting Ollama lets a half-open probe close the breaker and restore service.
- **Estimated effort:** One day.
- **Case note:** Build [B5.10] (backoff retry) first — the breaker counts *failed retries*, so the retry is the breaker's input signal. Treat the retry as the primary; the breaker is the follow-on.

## Interview defense

**Q: "What's buffr's retry and failure-handling story?"**

Mixed, and I can name exactly which cells are covered. Two are: `GemmaModelProvider` retries a botched tool-call JSON once with a corrective nudge (`maxToolCallAttempts`, default 2) — that's a real retry, but scoped to a *content* failure, with no backoff. And the memory write in `session.ask()` is wrapped in a swallowing try/catch — graceful degradation, correctly, because memory is non-critical and shouldn't risk the user's answer. The gap is the *transport*: `defaultHttpTransport` throws on any non-OK Ollama response with no retry and no backoff, and there's no circuit breaker — so a transient Ollama blip becomes a user-facing error, and a sustained outage throws full-latency on every turn. I'd add exponential backoff around the model call first, then a breaker for the down case.

```
buffr resilience — by failure type
  bad JSON:      retry once + nudge   ── COVERED (narrow, no backoff)
  memory fail:   swallow + degrade    ── COVERED (correct: non-critical)
  Ollama blip:   throw to UI          ── GAP: add backoff
  Ollama down:   throw every turn     ── GAP: add breaker
```

*Anchor:* "Retry the blip, trip the breaker on the outage, degrade what isn't essential — buffr does two of the three."

**Q: "You already retry. Why isn't that enough?"**

Because it retries the wrong layer for the failure I'm worried about. `maxToolCallAttempts` retries the model's *output* (unparseable JSON), not the *transport*. A network failure to Ollama never reaches that retry — it throws out of `defaultHttpTransport` first. The two are different layers and shouldn't be conflated; stacking them naively would multiply calls (2 × 3 = 6 per turn). The backoff retry belongs *inside* the transport with its own independent budget, beneath the tool-call loop.

```
two retries, two layers — keep them separate
  tool-call retry (content)  ── above: model output was wrong
  HTTP backoff (transport)   ── below: network was wrong   ◀ the missing one
  conflating them ──▶ budgets multiply (2×3=6 calls/turn)
```

*Anchor:* "Content retry and transport retry are different layers with independent budgets."

## See also

- `04-rate-limiting-backpressure.md` — the server-side counterpart: backpressure is the server saying "not now"; retry/breaker is the client hearing it correctly.
- `../../study-runtime-systems/` — cancellation and timeouts, the third leg of resilient calls (the `signal` already threaded through `GemmaModelProvider`).
- `../01-llm-foundations/08-provider-abstraction.md` — the injectable `chat` transport seam that makes the backoff retry a buffr-local change.
- `../05-evals-and-observability/` — where the trace sink already records `error` events, the substrate a breaker's failure count would build on.
