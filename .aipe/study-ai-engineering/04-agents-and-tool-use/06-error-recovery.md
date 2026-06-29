# Error Recovery — Failure as an Observation
### *Tool throws become input, hard stops bound the rest, and the gaps that remain*
**Type label:** agent resilience (fault handling)

## Zoom out

Error recovery isn't a layer — it's a property woven through the loop. Locate where failures *enter* and where they're *contained*.

```
Where failures enter and where they're caught
┌──────────────────────────────────────────────────────────┐
│  Agent loop      runAgentLoop — hard stops + try/catch      │  ← containment
├──────────────────────────────────────────────────────────┤
│  ★ RECOVERY      failure → observation, OR → bounded stop   │  ← this file
│     tool throws → tool_result{isError}                     │
│     budget hit  → forced synthesis                         │
│     bad JSON    → one retry nudge → prose                  │
├──────────────────────────────────────────────────────────┤
│  Tool / model    where things actually break                │  failure source
└──────────────────────────────────────────────────────────┘
```

Failures originate below (a tool throws, the model emits garbage); recovery (★) decides whether each one becomes *feedback the model can react to* or *a bound that ends the run*. That's the entire mental model: every failure is routed to one of those two fates.

Conversational version. You know the two ways to handle a failed `await`. You can `catch` it and *recover* — show a fallback, retry, degrade. Or you can let a *circuit breaker* trip — stop hammering, bail with a bounded result. buffr does both, and the elegant part is the first: when a tool throws, buffr doesn't crash and doesn't hide it — it hands the error *back to the model as an observation*, the same way a successful result would come back, so the model can read "that failed" and try a different move. Failure becomes input. The circuit breakers are the hard stops — `maxTurns`, `maxToolCalls`, forced synthesis — that guarantee the run ends no matter how badly the model behaves.

## Structure pass

The axis: **recoverable (feedback) vs bounded (stop).** Some failures the model can react to; some the code just has to cap.

```
The recovery axis
   RECOVERABLE                                       BOUNDED
   (feed back, model reacts)                         (cap it, end the run)
   ├─────────────────────────────────────────────────────────────┤
   tool throw → observation        bad JSON → 1 nudge    budget → forced synth
   model can try again              then prose            run always terminates
```

The seam: recoverable failures stay *inside* the loop (they become the next observation and the loop continues); bounded failures *exit* the loop (forced synthesis or break). A tool that throws is recoverable — the model gets another turn. A spent budget is bounded — there are no more turns.

```
Two fates for a failure
  failure
     ├─ RECOVERABLE → tool_result{isError:true} → model reads it → next turn
     └─ BOUNDED     → hard stop (maxTurns / maxToolCalls / forceFinal) → answer
```

## How it works

### Move 1 — the mental model

Recovery = turn the failure into something the loop already knows how to carry. A tool error is shaped like a tool result; a budget overrun is shaped like a normal turn-end. Nothing special-cases a crash because crashes are converted into the loop's existing currency.

```
Failures, normalized into loop currency
  tool throws        → tool_result with isError  (looks like an observation)
  budget exhausted   → forceFinal                 (looks like a normal turn)
  bad tool JSON      → retry nudge, then prose     (looks like an answer)
  empty answer       → FALLBACK_ANSWER             (looks like a string)
```

### Move 2 — step by step

#### Tool throws become observations (`try/catch` → `isError` tool_result)

Bridge from what you know: an error boundary that renders a fallback *into the same slot* as the real content. The model's "render" reads the error where it expected a result, and reacts.

```
A thrown tool error is fed back, not raised
  callTool(name, input)
     │ throws (network down, bad query, pipeline error)
     ▼ catch
  tool_result {
    content: JSON.stringify({ error: message }),   ← the error, serialized
    isError: true,                                  ← flagged so the model knows
  }
     │ pushed into messages as the observation
     ▼ next turn: model reads "{error: ...}" and can try a different query
```

Real code, `aptkit packages/runtime/src/run-agent-loop.ts:158`:

```ts
try {
  const { result, durationMs } = await tools.callTool(toolUse.name, toolUse.input, { signal });
  toolCall.result = result;
  resultContent = truncate(JSON.stringify(result));
} catch (error) {
  isError = true;
  const message = error instanceof Error ? error.message : String(error);
  toolCall.error = message;
  resultContent = truncate(JSON.stringify({ error: message }));   // ← error becomes the observation
}
// ...
toolResults.push({
  type: 'tool_result',
  toolUseId: toolUse.id,
  content: resultContent,
  ...(isError ? { isError: true } : {}),                          // ← isError flag travels with it
});
```

The consequence: a tool failure never crashes the run and never silently vanishes. The model sees `{error: "..."}` exactly where it expected chunks, and its next turn can adapt — rephrase, narrow, or give up gracefully. The `isError` flag tells the provider this observation is a failure, not data. This is the *recoverable* fate, in full.

#### Hard stop: turn and tool-call budgets (`maxTurns`, `maxToolCalls`)

Bridge: a retry cap. You've written `if (attempts >= 3) break`. Two caps here, whichever trips first.

```
Two circuit breakers, OR'd together
  budgetSpent = toolCalls.length >= maxToolCalls   (4)
  forceFinal  = turn === maxTurns - 1  OR  budgetSpent   (turns capped at 6)
     │ either trips
     ▼
  next model.complete gets tools: undefined → run MUST end in an answer
```

Real code, `aptkit packages/runtime/src/run-agent-loop.ts:98` and the `RagQueryAgent` values at `:75`:

```ts
for (let turn = 0; turn < maxTurns; turn += 1) {                  // ← maxTurns: 6 — iteration cap
  const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;  // ← 4 — spend cap
  const forceFinal = turn === maxTurns - 1 || budgetSpent;
  // ... tools: forceFinal ? undefined : toolSchemas ...
}
```

The consequence: two independent breakers. `maxTurns` bounds *time* (how many round trips); `maxToolCalls` bounds *work* (how many searches). A model that emits one tool call per turn hits `maxToolCalls` first; a model that loops without calling tools hits `maxTurns`. Either way the run terminates. There is no input that makes this loop run forever.

#### Bad tool JSON: one nudge, then prose (`RETRY_NUDGE`)

Bridge: a single retry with a corrected request, then give up gracefully — not an infinite retry storm.

```
Malformed tool JSON gets exactly one correction
  attempt 0: model emits broken {...}  (parseToolCall → null, but text has '{')
     │ looksLikeToolAttempt → retry
  attempt 1: + RETRY_NUDGE "respond with ONLY a single JSON object..."
     │ still null?
     ▼ fall through: treat raw text as the answer (prose)
```

Real code, `aptkit packages/providers/gemma/src/gemma-provider.ts:77` (full path in `02-tool-calling.md`):

```ts
if (wantsTool) {
  const call = parseToolCall(raw);
  if (call) return this.toResponse([{ type: 'tool_use', ... }], lastResponse);
  if (looksLikeToolAttempt(raw)) continue;   // ← ONE retry with nudge, then break to prose
}
```

The consequence, stated honestly: this is a *one-shot* recovery, and it only fires for *malformed* JSON. JSON that parses but has the wrong *arguments* (the `{"q":...}` case from `02-tool-calling.md`) is not malformed — it never triggers the nudge. So this recovery catches "the model produced broken JSON," not "the model produced valid JSON with wrong keys." The second, more dangerous case, sails through unrecovered.

#### Empty answer: the fallback string (`FALLBACK_ANSWER`)

Bridge: a default value for an empty render. Never hand the user a blank.

```
Empty final → a sentence, never nothing
  finalText.trim() || FALLBACK_ANSWER
     │ empty?
     ▼ "I couldn't find anything in the knowledge base to answer that."
```

Real code, `aptkit packages/agents/rag-query/src/rag-query-agent.ts:82`:

```ts
return finalText.trim() || FALLBACK_ANSWER;   // ← never return an empty string to the user
```

The consequence: if the whole loop produces no usable text — model returned empty, synthesis stalled — the user still gets a coherent sentence, not a blank. It's the last guard, after every other recovery has failed.

### Move 2.5 — current vs future (the honest gaps)

```
What recovery does NOT do today (✗) and could (✓)
  ✗ no loop detection: the same search twice burns budget; nothing notices
     ✓ hash (name,input); on repeat → force synthesis early                [B4.2]
  ✗ no per-tool timeout: a slow callTool only stops via AbortSignal cancel
     ✓ wrap callTool in a timeout → treat timeout as an isError observation
  ✗ one-shot JSON retry only: bad JSON gets ONE nudge, then becomes prose
     ✓ validate args + re-prompt with the specific schema error              [B4.3]
```

These aren't oversights to hide in an interview — they're the real edges of the current design. The loop is *bounded* (it always terminates) but not *smart* about how it spends the bound: it can waste all four tool calls re-running an identical failing search, and it can't interrupt a hung tool except by cancelling the whole run. Name these plainly.

### Move 3 — the principle

Good agent recovery has two jobs: keep recoverable failures *in the loop* as feedback, and keep everything else *bounded* so the run can't hang or spin. buffr does both cleanly — errors become observations, budgets force an ending. What it doesn't yet do is *reason about its own failures*: it can't tell it's repeating itself, and it can't time out one slow tool. The load-bearing guarantee is termination; the missing sophistication is efficiency within that bound.

## Primary diagram

The full recovery map — every failure mode and its fate.

```
buffr error recovery: every failure, routed
  ┌─ tool throws ─────────► catch → tool_result{isError} ──► model reacts (RECOVER)
  │
  ┌─ bad tool JSON ───────► RETRY_NUDGE (once) ──► still bad? ──► prose
  │
  ┌─ wrong-key args ──────► ✗ NOT caught (valid JSON) ──► empty query, silent
  │                          (the 02-tool-calling ceiling)
  ┌─ budget hit ──────────► forceFinal → tools stripped ──► forced synthesis (BOUND)
  │
  ┌─ maxTurns hit ────────► loop exits ──► forced synthesis (BOUND)
  │
  ┌─ empty final text ────► FALLBACK_ANSWER (BOUND, last guard)
  │
  ┌─ repeated identical call → ✗ NO detection ──► burns budget silently
  │
  └─ slow / hung tool ─────► ✗ NO per-tool timeout ──► only AbortSignal cancels whole run
```

## Elaborate

The cleanest thing about this design is that *recovery reuses the loop's normal data path*. A tool error isn't handled by a special error channel — it's stuffed into a `tool_result` block, the exact shape a success uses, with one extra `isError` flag. That means the model's reaction to an error and its reaction to a result go through identical machinery; there's no separate "error mode" for the model to get confused by. It just reads its observations, one of which happens to say `{error: ...}`. Simplicity through uniformity.

The sharpest gap to internalize is the one that *isn't* on the recovery map as a recoverable case: wrong-key arguments. A tool that *throws* recovers beautifully. A tool that *succeeds with garbage input* — because the emulated path never validated the args — produces no error to recover from. There's nothing to catch. That's why `02-tool-calling.md` calls argument validation the reliability ceiling: error recovery is excellent at handling failures that *announce themselves*, and powerless against failures that *look like success*. The empty-query search is the canonical "looks like success" failure, and the entire recovery system never sees it.

## Project exercises

### Add a per-tool timeout that degrades to an error observation

- **Exercise ID:** [B4.11], Phase 4.
- **What to build:** Wrap each `callTool` in a timeout (e.g. via `AbortSignal.timeout` composed with the existing signal). On timeout, produce an `isError` tool_result saying the tool timed out, so the model can react — rather than the whole run hanging until the outer signal fires.
- **Why it earns its place:** Today a slow or hung tool can stall a turn indefinitely; the only escape is cancelling the entire run. A per-tool timeout converts "the run hangs" into "the model gets a timeout observation and tries something else" — turning a bounded-but-stuck case into a recoverable one. It directly fills a named gap.
- **Files to touch:** `aptkit packages/runtime/src/run-agent-loop.ts` (compose a timeout signal around `callTool`), respecting the existing `signal` cancellation.
- **Done when:** A tool that exceeds the timeout yields an `isError` observation (not a hang), the model gets another turn, and an explicit `AbortSignal` cancel still aborts immediately. Covered by a test with a slow scripted tool.
- **Estimated effort:** 3–4 hours.

### Detect and short-circuit repeated identical tool calls

- **Exercise ID:** [B4.12], Phase 4.
- **What to build:** Hash each `(toolName, input)`; if the exact pair repeats within a run, stop spending budget on it — force synthesis early and emit a `loop_detected` trace event. (Shares intent with [B4.2] in `01-agents-vs-chains.md`; here it's framed as recovery.)
- **Why it earns its place:** Re-issuing the identical failing search is a weak model's signature failure, and today the loop happily burns all four tool calls on it before the budget saves it. Detecting the repeat converts wasted budget into an immediate, honest "I have what I have, answering now." It's recovery from the model's own non-convergence.
- **Files to touch:** `aptkit packages/runtime/src/run-agent-loop.ts`, `buffr src/supabase-trace-sink.ts` (persist the `loop_detected` event).
- **Done when:** A scripted duplicate `search_knowledge_base` call triggers forced synthesis on the repeat with a `loop_detected` trace event, and non-duplicate multi-call runs are unaffected.
- **Estimated effort:** 2–3 hours.

## Interview defense

**Q: "What happens when a tool fails mid-run?"**

It becomes an observation, not a crash. `callTool` is wrapped in try/catch; on a throw, the loop serializes the error into a `tool_result` block with `isError: true` and pushes it into `messages` exactly where a success would go. The model reads `{error: ...}` on its next turn and can react — rephrase the query, narrow it, or give up gracefully. Failure is fed back as input.

```
  callTool throws → tool_result{isError} → model's next turn reads it → adapts
```

*Anchor: a thrown tool error never crashes the run — it's handed back to the model through the normal observation path.*

**Q: "What stops a misbehaving model from running forever or spinning on the same call?"** — the part people forget.

Termination is guaranteed; efficiency isn't. Two hard stops bound every run: `maxTurns` (6) caps iterations, `maxToolCalls` (4) caps tool spend, and whichever trips first forces synthesis by stripping the tools. So the run *always* ends. But — and this is the honest gap — there's **no loop detection**: a model can re-issue the *identical* search up to four times, and nothing notices; the budget just runs out. There's also no per-tool timeout (only whole-run `AbortSignal` cancel) and the JSON retry is one-shot. The load-bearing fact people forget: the loop is bounded, not smart — it guarantees an ending, not an efficient path to one.

```
  maxTurns(6) OR maxToolCalls(4) → forced synth → ALWAYS ends
  but: identical call ×4? → no detection → budget wasted
```

*Anchor: the hard stops guarantee termination; loop detection, timeouts, and arg validation are the recovery gaps that remain.*

## See also

- **`02-tool-calling.md`** — the wrong-key argument failure that recovery can't catch (it looks like success).
- **`03-react-pattern.md`** — `forceFinal` as the bounded stop, here seen as a circuit breaker.
- **`01-agents-vs-chains.md`** — the hard stops as the guardrails that make the hybrid safe.
- **`../05-evals-and-observability/`** — the trace sink that records `tool_call_end` errors and where you'd see recovery happen.
