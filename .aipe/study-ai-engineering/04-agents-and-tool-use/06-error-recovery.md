# Error recovery — agent failure modes and what stops them

*Industry standard (agent robustness). buffr recovers from budget overruns, context overflow, and memory-write failures; it does NOT recover from wrong-arg tool calls — that gap is the headline.*

## Zoom out, then zoom in

An agent loop is a small machine that calls a flaky model and a flaky tool in a loop. Every layer can fail, and the question this file answers is: **when something goes wrong, does the loop catch it, contain it, and keep producing a useful answer — or does it fail silently?** buffr has three real recoveries and two named gaps, and the gaps are the interesting part.

```
  Zoom out — the failure layers, and what guards each

  ┌─ Session ───────────────────────────────────────────────────┐
  │  memory.remember in try/catch        ← RECOVERED (best-effort)│
  └───────────────────────────┬─────────────────────────────────┘
                              │  agent.answer(question)
  ┌─ Agent loop (aptkit) ─────▼─────────────────────────────────┐
  │  ★ maxTurns / maxToolCalls hard stop  ← RECOVERED (budget) ★ │  ← we are here
  │    forceFinal synthesis turn          ← RECOVERED (no-loop)   │
  │    callTool throw → tool_result error ← RECOVERED (bad NAME)  │
  │    parseToolCall → null               ← handled (treated as   │
  │                                          a final answer)       │
  │    wrong ARG (q vs query) → empty ''  ← NOT RECOVERED ✗       │
  └───────────────────────────┬─────────────────────────────────┘
                              │  model.complete(...)
  ┌─ Provider ────────────────▼─────────────────────────────────┐
  │  ContextWindowGuard: refuse + warn   ← RECOVERED (overflow)   │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: "recovery" splits into two flavors. **Containment** — stop a failure from spreading or hanging (the budget, the context guard, the memory swallow). **Correction** — turn a failure into a retry with better information (the tool-error-as-observation path). buffr has plenty of containment, one piece of correction (bad tool *name*), and a glaring missing correction (bad tool *args*) that fails silently — the same ceiling from `02-tool-calling.md`, seen now as a recovery gap.

## Structure pass

**Layers:** session (best-effort writes) → loop (budget + tool-error handling) → provider (context guard). Each layer owns one failure class.

**Axis — "when this layer fails, is the failure contained, corrected, or silent?" — traced down:**

```
  trace "failure disposition" across the layers

  ┌─ session ───────────────────┐  memory write throws
  │  → try/catch swallow         │  → CONTAINED (answer survives)
  └──────────────────────────────┘
      ┌─ loop: budget ─────────────┐  model loops on tool
      │  → forceFinal, drop tools   │  → CONTAINED (forced to answer)
      └─────────────────────────────┘
          ┌─ loop: bad tool NAME ─────┐  callTool throws
          │  → catch → error Observation│ → CORRECTED (model retries)
          └─────────────────────────────┘
              ┌─ loop: bad tool ARG ──────┐  wrong key → ''
              │  → no guard                │ → SILENT ✗ (the gap)
              └─────────────────────────────┘
                  ┌─ provider: overflow ──────┐  input too big
                  │  → refuse + warn + throw   │ → CONTAINED (no crash)
                  └─────────────────────────────┘

  the disposition flips per layer: contained · contained · CORRECTED · SILENT · contained
```

**The seam:** the one boundary where disposition flips from "corrected" to "silent" is *inside one layer* — the loop catches a thrown tool error (bad name) but never sees a wrong-arg call because the handler swallows it into an empty query before it can throw. Same layer, two failures, opposite outcomes. That's the seam to study.

## How it works

### Move 1 — the mental model

Think of how a robust `fetch` wrapper handles failure: a timeout (don't hang forever), a `try/catch` (don't crash the page), a retry-with-backoff (correct a transient blip), and — the bug — a path where a 200-with-garbage-body slips through as "success." buffr's loop has all four. The timeout is the iteration budget, the catch is the memory swallow and the context guard, the retry is the tool-error-as-observation, and the garbage-success is the empty-query failure.

```
  the recovery taxonomy — two strategies, mapped to buffr

  CONTAIN (stop the bleed)          CORRECT (retry smarter)
  ─────────────────────             ───────────────────────
  budget hard-stop          ┌────►  tool error → Observation
  forceFinal synthesis      │       (model sees failure, retries)
  context-guard refusal     │
  memory try/catch          │       MISSING: wrong-arg correction
                            │       (silent empty search — no signal
   all bound latency &      │        to retry on)
   protect the answer ──────┘
```

### Move 2 — the step-by-step walkthrough

Each of these is reached on a real failure during `agent.answer()`. Walk them one at a time.

**Recovery 1 — the budget hard-stop contains a model that won't quit.** A model can loop forever calling the tool, never emitting a final answer. The loop refuses to trust it: every turn computes whether the budget is spent, and on the last turn (or once tool-calls hit the cap) it sets `forceFinal`.

```ts
// aptkit packages/runtime/src/run-agent-loop.ts:101-109
const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
const forceFinal = turn === maxTurns - 1 || budgetSpent;   // ← the hard stop
const response = await model.complete({
  system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
  tools: forceFinal ? undefined : toolSchemas,             // ← no tools on the final turn
  maxTokens, signal,
});
```

buffr sets `maxTurns:6, maxToolCalls:4` (`rag-query-agent.ts:62-83`). So no matter how confused the model gets, the loop runs at most 6 model calls and 4 tool calls, then stops. This is pure containment: it bounds latency and guarantees termination. The cost — it may answer with imperfect context — is accepted on purpose.

```
  Recovery 1 — budget contains the runaway loop

  turn:   0    1    2    3    4    5
  tools:  ✓    ✓    ✓    ✓    ✗    ✗     ← forceFinal once toolCalls>=4 or turn==5
                              └──────┴──► tools=undefined → model MUST answer
```

**Recovery 2 — the synthesis instruction corrects the "I need more queries" non-answer.** Dropping the tools isn't enough on its own — a model told "no tools" might still reply "I'd need to search for X to answer." So `forceFinal` also injects an instruction that forbids exactly that.

```ts
// aptkit packages/runtime/src/run-agent-loop.ts:72-74
export function buildSynthesisInstruction(middle: string): string {
  return `You have NO more tool calls available. ${middle} Do not say you need more queries.`;
}
// buffr's middle (rag-query-agent.ts): "Now answer directly and concisely, citing the sources you retrieved."
```

This is a small but real correction: it transforms a likely non-answer ("I can't, I need to search") into a committed answer from whatever context is already in hand. Without it, the budget would terminate the loop on a useless turn.

```
  Recovery 2 — synthesis turn forces a real answer

  budget spent ─► system += "NO more tool calls... Do not say you need more queries"
               ─► tools = undefined
               ─► model.complete ─► answer (not "I need to search")
```

**Recovery 3 — a thrown tool error becomes an Observation the model can retry on.** This is buffr's one piece of *correction* in the tool path. If the model emits a tool-call with a bad **name**, `callTool` throws (`tool-registry.ts:57`, "tool not found"). The loop catches it and feeds the error back as a `tool_result` with `isError: true` — the model sees its action failed and gets another turn to fix it.

```ts
// aptkit packages/runtime/src/run-agent-loop.ts:158-189 (condensed)
try {
  const { result, durationMs } = await tools.callTool(toolUse.name, toolUse.input, { signal });
  resultContent = truncate(JSON.stringify(result));
} catch (error) {
  isError = true;
  const message = error instanceof Error ? error.message : String(error);
  toolCall.error = message;
  resultContent = truncate(JSON.stringify({ error: message }));   // ← the error IS the Observation
}
// ...
toolResults.push({ type: 'tool_result', toolUseId: toolUse.id, content: resultContent, ...(isError && { isError: true }) });
messages.push({ role: 'user', content: toolResults });            // ← model sees the error next turn
```

Concretely: model emits `{"tool":"serch_kb",...}` (typo). `callTool` throws "tool not found: serch_kb". The loop wraps it as `{error: "tool not found: serch_kb"}`, the model reads that next turn and can re-emit the correct name. **A bad tool name is recoverable** because it throws, and the loop turns throws into observations.

```
  Recovery 3 — bad NAME corrected via error-as-Observation

  model: {"tool":"serch_kb"}  ← typo
    │ callTool → THROWS "tool not found"
    │ catch → tool_result {error, isError:true}
    │ messages.push(user: that error)
    ▼
  next turn: model sees the error → retries with "search_knowledge_base"  ✓
```

**Recovery 4 — the context guard refuses an overflowing request instead of letting it crash.** Before any oversized prompt reaches Ollama, `ContextWindowGuardedProvider` estimates the input tokens; if they exceed `maxTokens - outputReserve`, it emits a `warning` and throws `ContextWindowExceededError` rather than sending a request that would overflow gemma2:9b's window.

```ts
// aptkit packages/providers/local/src/context-window-guard.ts:57-70
const estimate = estimateContextWindow(request, this.options);
if (!estimate.ok) {
  this.options.trace?.emit({ type: 'warning', capabilityId: this.options.capabilityId,
    message: `Skipping local provider ...: estimated ${estimate.estimatedInputTokens} input tokens exceed ${estimate.availableInputTokens}.`,
    timestamp: timestamp() });
  throw new ContextWindowExceededError(estimate);     // ← refuse, don't overflow
}
return this.provider.complete(request);
```

buffr wires this with `{ maxTokens: 8192 }` (`src/session.ts:46`). This is containment with a twist: it converts a would-be silent truncation (or a provider error mid-stream) into a clean, *observable* refusal — the `warning` lands in `agents.messages`, so the failure is visible (`../05-evals-and-observability/04-llm-observability.md`).

```
  Recovery 4 — context guard refuses + warns

  input estimate ─► > (maxTokens 8192 - reserve 768)?
                       │ yes
                       ▼
                  emit 'warning' (→ messages row)  +  throw ContextWindowExceededError
                       (no overflow, failure is visible)
```

**Recovery 5 — memory writes are best-effort, so a DB hiccup never costs the answer.** Back at buffr's layer, the conversation-memory write runs *after* the answer is in hand, inside a swallowing `try/catch`. A memory failure degrades future recall; it never fails the current turn.

```ts
// src/session.ts:62-70
const answer = await agent.answer(question);
await trace.flush();
try {
  await memory.remember({ conversationId, question, answer });
} catch {
  // swallow: memory is best-effort, the turn already succeeded
}
return answer;
```

Ordering is the recovery here: `remember` runs after the answer is ready, so even an unhandled throw inside it is caught and dropped. This is deliberate containment — memory is an enhancement, the answer is the product.

### Move 2.5 — the gaps: what is NOT recovered

Two failures slip through, and being able to name them precisely is the interview win.

**Gap A — wrong tool ARG fails silently (the headline gap).** From `02-tool-calling.md`: there's no arg-schema validation. A model that emits `{"arguments":{"q":"..."}}` (wrong key) doesn't throw — the handler coerces the missing `query` to `''` (`search-knowledge-base-tool.ts`), searches over the empty string, and returns four arbitrary chunks. Because nothing throws, Recovery 3's error-as-Observation never fires; the model never learns it asked the wrong question.

```
  Gap A — wrong ARG bypasses every recovery

  model: {"arguments":{"q":"coffee"}}   ← wrong key
    │ parseToolCall → {input:{q:"coffee"}}   ✓ (no schema check)
    │ callTool → name found, NO throw        ✗ Recovery 3 can't fire
    │ handler: args.query → '' → search('')  ✗ no signal to correct
    ▼
  answer over noise — every layer reports success
```

The fix is a buffr-side guard that validates args against `inputSchema.required` and *throws* on a miss — which would route straight into Recovery 3's error-as-Observation path and become correctable. (Exercise ERR-1.)

**Gap B — `parseToolCall` returning null is handled, but not as a recovery.** When the model emits prose where a tool-call JSON was expected, `parseToolCall` returns null (`gemma-provider.ts:168-182`), so the provider yields a plain text block, no `tool_use`. The loop reads "no Action" and treats that text as the *final answer* (run-agent-loop.ts:131-135). That's not wrong, exactly — but a model that *meant* to call a tool and botched the JSON gets its half-formed prose shipped as the answer with no warning. There's no `warning` event, no retry. (Exercise ERR-2 makes it observable; aptkit's unused `recoveryPrompt`/`runRecoveryTurn` at run-agent-loop.ts:195-228 is the shape a real correction would take.)

```
  Phase A (today)                      Phase B (with the arg guard)
  ─────────────                        ──────────────────────────
  bad NAME  → throw → corrected ✓      bad NAME  → throw → corrected ✓
  bad ARG   → '' → silent ✗            bad ARG   → throw → corrected ✓
  parse null → shipped as answer       parse null → 'warning' emitted, observable
```

### Move 3 — the principle

Recovery is two jobs: **contain everything, correct what you can.** buffr contains well — it never hangs, never crashes on overflow, never loses an answer to a memory hiccup. Where it's weak is correction, and the rule that exposes the weakness is simple: *a failure can only be corrected if it produces a signal.* A thrown error is a signal (Recovery 3 catches it). A silently-coerced empty query is not (Gap A). So the highest-leverage recovery work is usually upstream — making silent failures throw — not adding more catch blocks.

## Primary diagram

```
  buffr error recovery — every failure and its disposition, one frame

  ┌─ Session ────────────────────────────────────────────────────┐
  │  memory.remember in try/catch ──────► CONTAIN (answer safe)    │
  └───────────────────────────┬───────────────────────────────────┘
                              │ agent.answer
  ┌─ Loop (runAgentLoop) ─────▼───────────────────────────────────┐
  │  budgetSpent = toolCalls>=4                                     │
  │  forceFinal  = turn==5 || budgetSpent ─► CONTAIN (terminate)    │
  │     + synthesisInstruction            ─► CORRECT ("answer now") │
  │                                                                │
  │  for each tool_use:                                            │
  │    callTool ── throws? (bad NAME) ─► catch ─► error Observation │
  │                                      ─► CORRECT (model retries) │
  │    callTool ── bad ARG (q vs query) ─► '' ─► SILENT ✗  ◄── gap  │
  │                                                                │
  │  parseToolCall → null ─► treated as final answer (no warn) ◄ gap│
  └───────────────────────────┬───────────────────────────────────┘
                              │ model.complete
  ┌─ Provider guard ──────────▼───────────────────────────────────┐
  │  input estimate > 8192-768 ─► emit 'warning' + throw           │
  │                            ─► CONTAIN (no overflow, observable) │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

The "turn a tool error into an observation and let the model retry" pattern is the canonical agent-recovery move — it's why native tool-calling APIs return tool errors *to the model* rather than to your code. aptkit implements exactly that (run-agent-loop.ts:163-189). The iteration budget descends from the same lineage as ReAct's max-steps and any bounded-search algorithm: never trust an autonomous loop to terminate itself. buffr's specific gap — silent arg coercion — is a textbook example of why "be liberal in what you accept" (Postel's law) is *wrong* for agent tool inputs: a handler that defaults a missing required arg to `''` trades a loud, correctable error for a quiet, uncorrectable one. The structured-output discipline (`02-tool-calling.md`, `../01-llm-foundations/04-structured-outputs.md`) is the same lesson from the validation side; the observability story (`../05-evals-and-observability/04-llm-observability.md`) is what makes the gaps measurable.

## Project exercises

> No curriculum file present; exercises derived from the codebase.

### Make wrong-arg tool calls throw, routing them into the existing retry path

- **Exercise ID:** ERR-1 (Case B — wrong-arg recovery not yet exercised). **The highest-leverage recovery exercise.**
- **What to build:** a buffr-side handler wrapper that checks the tool's `inputSchema.required` keys are present and correctly typed *before* searching; on a miss, throw — which the loop already catches and feeds back as a correctable `tool_result` error (Recovery 3).
- **Why it earns its place:** converts buffr's one silent failure (Gap A) into a correctable one for free, reusing the existing error-as-Observation path. The "I made my agent's quiet failure loud and self-healing" story.
- **Files to touch:** `src/session.ts:43-44` (wrap `tool.handler` before registering in `InMemoryToolRegistry`), or a new `src/validated-tool.ts`.
- **Done when:** a forced wrong-key tool-call produces a `tool` error row in the trace and a corrected retry on the next turn, verified by a test.
- **Estimated effort:** 1–4hr.

### Surface parse-null and force-final as warning events

- **Exercise ID:** ERR-2 (Case B — silent-handling made observable).
- **What to build:** emit a `warning` trace event when `parseToolCall` returns null mid-loop (Gap B) and when `forceFinal` fires due to budget exhaustion, so both failure-adjacent paths are visible in `agents.messages`.
- **Why it earns its place:** you can't recover what you can't see; this turns two silent handlings into measurable signals you can later act on.
- **Files to touch:** `src/supabase-trace-sink.ts` (already persists `warning` — surface them); the emit point for budget exhaustion would be a buffr-side wrapper since `runAgentLoop` is aptkit-owned and not edited.
- **Done when:** an eval run reports how often the loop hit `forceFinal` and how often a turn's tool-call failed to parse.
- **Estimated effort:** 1–4hr.

## Interview defense

**Q: What happens in buffr when the model keeps calling the tool and never answers?**
Answer: it can't run forever. `forceFinal = turn == maxTurns-1 || toolCalls >= maxToolCalls` (6 and 4 in buffr) strips the tools on the final turn and injects a synthesis instruction — "You have NO more tool calls available… Do not say you need more queries." That contains a runaway loop and corrects the likely "I need to search more" non-answer into a committed one.

```
  budget hard-stop:  turn==5 OR toolCalls>=4 → drop tools + "answer now"
```

**Q: Which tool failures does buffr recover from, and which does it miss?**
Answer: a bad tool *name* is recovered — `callTool` throws, the loop catches it and feeds the error back as an Observation, so the model retries (run-agent-loop.ts:163-189). A bad tool *arg* is NOT — there's no schema validation, so a wrong key coerces to an empty-string search with no throw, no signal, no retry. **The part people forget: a failure is only correctable if it produces a signal.** The fix is making wrong-args throw, which routes them into the exact retry path bad names already use.

```
  bad NAME → throws → corrected ✓   ·   bad ARG → '' → silent ✗ → (fix: make it throw)
```

## See also

- `02-tool-calling.md` — the unvalidated-args ceiling, seen here as the recovery gap.
- `03-react-pattern.md` — how a failed Action becomes an Observation the model reacts to.
- `01-agents-vs-chains.md` — the budget hard-stop as the loop's termination guarantee.
- `../05-evals-and-observability/04-llm-observability.md` — the `warning`/`error` events that make failures visible.
