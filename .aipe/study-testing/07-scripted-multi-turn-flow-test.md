# Scripted multi-turn flow test

**Industry name:** state-machine / reducer test · scripted-input test. *Language-agnostic pattern (the same shape as testing a Redux reducer or an XState machine by dispatching a sequence and asserting state), here on two interactive CLI conversations.*

**Determinism seam:** testing (deterministic). Every assertion is exact — `assert.strictEqual(result.step, 'promote')`. The flow object never touches the network, the terminal, or a clock; only the injected session's stubbed async methods return canned data. No thresholds, no LLM output asserted directly.

---

## Zoom out, then zoom in

`/research` and `/review` are multi-turn conversations, not one-shot commands — `/research` walks predict → reveal → discard/hypothesis/decision → stake → resolution → review-date; `/review` walks entry → keep/snooze/resolve → date/disposition/note, one item at a time. A conversation like that is exactly the kind of code that's hard to test the obvious way: you'd need to drive a real terminal, feed keystrokes through `stdin`, and read back what got printed — slow, brittle, and coupled to the OpenTUI renderer. buffr sidesteps all of that by extracting the conversation into a **pure state machine with no I/O of its own**, and testing *that* directly.

```
  Zoom out — where the flow objects sit

  ┌─ UI layer ────────────────────────────────────────────────────┐
  │  chat.tsx: <textarea> onSubmit → activeFlow.controller.submit  │
  └───────────────────────────┬──────────────────────────────────┘
                              │ plain async calls, no stdin/stdout
  ┌─ Flow layer ─────────────▼──────────────────────────────────┐
  │  ★ createResearchFlow(session, topic, cb): ResearchFlow ★    │ ← we are here
  │  ★ createReviewFlow(session): ReviewFlow ★                   │   (tested HERE)
  │  { start(): Promise<Result>; submit(input): Promise<Result> } │
  └───────────────────────────┬──────────────────────────────────┘
                              │ session.researchCollect / .saveDecision / …
  ┌─ Session layer ──────────▼──────────────────────────────────┐
  │  ChatSession — the interface the flow depends on, injected   │
  └───────────────────────────┬──────────────────────────────────┘
                              │ (untested here — see audit.md lens 1)
  ┌─ Engine / Postgres ───────▼──────────────────────────────────┐
  │  MarketResearchEngine, PgJournalStore                        │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is a **scripted multi-turn flow test** — the interactive loop is written as an explicit state machine (`step` + closed-over local state), exposing exactly two methods, `start()` and `submit(input)`, each returning `{ messages, step }`. The test drives the conversation by calling `submit()` in the same sequence a real user's keystrokes would produce, asserting the returned `step` (and, where it matters, the captured side effect) after each turn. No mocked `stdin`, no fake `readline`, no OpenTUI at all.

---

## The structure pass

**Layers:** (1) the test, scripting a sequence of `submit()` calls, (2) the flow object (`createResearchFlow`/`createReviewFlow`), holding `step` and per-conversation state in closure variables, (3) the injected `ChatSession` — a plain object literal satisfying the `ChatSession` type, (4) `chat.tsx`, the only real caller, wiring `activeFlow.controller.submit(q)` to a `<textarea>` submit handler.

**Axis traced — *who decides what happens next?*** Layer 1 (the test) decides *what input arrives*, exactly the way a human typing at the prompt would. Layer 2 (the flow) decides *what state that input produces* — parsing, validating, transitioning `step`, and deciding which `session` method to call. Layer 3 (the session) decides *what data comes back* for a given call — and in the tests, that decision is scripted per-test via `overrides`. Layer 4 (`chat.tsx`) decides *nothing* about the conversation logic; it only decides where the returned `messages` get rendered and whether `activeFlow` stays set. Control over the conversation's shape lives entirely in layer 2 — that's the seam that makes this pattern possible.

**The seam:** the boundary between "conversation logic" and "the rest of the app" is the `{ start(), submit(input) }` shape itself — no `readline`, no `process.stdin`, no `chat.tsx` React state on either side of it. That's a *deliberate* extraction: the flow doesn't know it's running inside a terminal UI at all. It could be driven by a test, a different UI, or a script with equal ease. Everything the flow depends on beyond its own closure state comes through one injected object (`ChatSession`) — a second seam, the same dependency-injection discipline `03-contract-parity-test.md` and `02-fake-embedder-injection.md` already rely on, applied here to an interactive loop instead of a single function call.

---

## How it works

### Move 1 — the mental model

You know how a Redux reducer takes `(state, action) → newState`, and you test it by dispatching a sequence of actions and asserting the state after each one — no store, no React, no DOM? `createResearchFlow` and `createReviewFlow` are that same shape, just async and with the "action" being free-text user input instead of a typed action object. `submit(input)` is the reducer call; `step` is the piece of state the test watches.

```
  The scripted-flow kernel

   test calls:  start() ──► submit(in1) ──► submit(in2) ──► submit(in3) ──► …
   flow returns: {step: 'prediction'} {step: 'promote'} {step: 'stake'} {step: 'resolution'}

   at each step: assert the step is what you expect,
                 and (sometimes) assert a session method was — or wasn't — called
```

The kernel is a `switch`-shaped `submit()` (in `research-flow.ts` it's a chain of `if (step === '…')` blocks) closing over five pieces of local state: `step`, `collected`, `output`, `prediction`, `stake`, `resolutionCondition` (`research-flow.ts:74-79`). Each branch reads one piece of input, validates it, and either re-prompts at the *same* step (invalid input) or advances `step` and returns a new prompt. That's the entire mechanism — no class, no external state store, just closure variables mutated by successive `submit()` calls.

### Move 2 — the walkthrough

**The flow is constructed once per conversation, with the session and the topic fixed at creation.** `createResearchFlow(session, topic, callbacks)` (`research-flow.ts:73`) takes the topic once — it never appears in `submit()`'s signature — because the whole point of `start()`/`submit()` is that everything the conversation is *about* gets nailed down up front; only the user's answers move it forward turn to turn.

```
  Layers-and-hops — one turn of research-flow

  ┌─ test ────────────┐  hop1: submit('60 frequency 50')  ┌─ flow (closure) ──┐
  │  scripted input    │ ──────────────────────────────────► │ step==='prediction'│
  └────────────────────┘                                     │ parsePrediction()   │
                          hop4: {step:'promote', messages}    │ session.research-  │
             ◄─────────────────────────────────────────────  │  Evaluate(...)      │
                                                        hop2 │ └────────┬────────────┘
                                                              │          │ hop3: awaits
                                                              │          ▼
                                                    ┌─ injected ChatSession stub ──┐
                                                    │ researchEvaluate: async ()   │
                                                    │  => ({ output: makeOutput() })│
                                                    └────────────────────────────────┘
```

**Invalid input re-prompts at the same step, and — critically — the test proves the expensive call didn't happen.** This is the sharpest assertion in the suite:

```ts
// test/research-flow.test.ts:99-124
let evaluateCalls = 0;
const session = makeStubSession({
  researchEvaluate: async () => { evaluateCalls++; return { output: makeOutput() }; },
});
const flow = createResearchFlow(session, 'shopify returns management', {});
await flow.start();

const badFormat = await flow.submit('not a valid prediction');
assert.strictEqual(badFormat.step, 'prediction');
assert.strictEqual(evaluateCalls, 0);          // ← not just "still on this step" —

const badDimension = await flow.submit('60 made-up-dimension 50');
assert.strictEqual(badDimension.step, 'prediction');
assert.strictEqual(evaluateCalls, 0);          // ← proves the model call never fired

const ok = await flow.submit('60 frequency 50');
assert.strictEqual(ok.step, 'promote');
assert.strictEqual(evaluateCalls, 1);          // ← fires exactly once, on the valid input
```

Three malformed inputs — wrong shape, invalid dimension, out-of-range score — are checked *before* the assertion on `step`. Each one has to independently prove `parsePrediction` rejected it without ever reaching `session.researchEvaluate`. A test that only asserted `step === 'prediction'` after bad input could still be hiding a bug where the flow re-prompts *and* fires the (expensive, LLM-backed) evaluate call anyway. Counting calls is the difference between "looks right" and "is right."

**The stub session doubles as a call-order and non-call assertion, not just a data source.** `review-flow.test.ts` takes this further — it deliberately makes the *unused* methods throw:

```ts
// test/review-flow.test.ts:29-30 (in research-flow.test.ts's stub, mirrored the other way in review-flow.test.ts)
researchCollect: async () => { throw new Error('not used'); },
researchEvaluate: async () => { throw new Error('not used'); },
```

`review-flow` never calls `researchCollect`/`researchEvaluate` — they belong to the *other* flow. Wiring them to throw turns "this method should never be called from this flow" into an assertion that fails loudly if the flows are ever accidentally cross-wired, instead of silently returning `''` and masking the bug. The base stub's other methods stay quiet no-ops (`ask: async () => ''`, `close: async () => {}`) — only the two that would be a real error if reached are wired to blow up. That's a deliberate two-tier fake: silent defaults for "don't care," loud failure for "must never happen."

**Terminal-state assertions capture what got persisted, not just how the conversation ended.** The `decision` path is the deepest one — four turns (`decision` → stake → resolution → review-date) before anything is saved:

```ts
// test/research-flow.test.ts:142-174
const session = makeStubSession({ saveDecision: async (input) => { captured = input; } });
const flow = createResearchFlow(session, 'shopify returns management', {});
await flow.start();
await flow.submit('60 frequency 50');
await flow.submit('decision');                                    // step: stake
await flow.submit('Build a landing page and run ads for 2 weeks'); // step: resolution
await flow.submit('10+ email signups in 2 weeks');                 // step: review-date
await flow.submit('30');                                           // step: done

assert.strictEqual(captured!.stake, 'Build a landing page and run ads for 2 weeks');
assert.strictEqual(captured!.prediction.expectedScore, 60);       // carried from turn 1
assert.strictEqual(captured!.assessment.score, 78);                // carried from turn 2's reveal
assert.ok(new Date(captured!.reviewAt).getTime() > Date.now());   // parseDayCountOrDate resolved '30' → a real future date
```

The test doesn't just check the flow *ends* at `done` — it captures the exact object `saveDecision` was called with, and checks that data entered on turn 1 (`prediction`) and computed on turn 2 (`assessment`) both survive intact to the call on turn 5. That's the thing a multi-turn flow can silently break that a single-call test can't catch: a later turn overwriting or dropping state a much earlier turn set.

### Move 3 — the principle

The reason this pattern is testable at all is an architectural choice made *before* any test was written: the conversation logic was pulled out of the component that renders it. `chat.tsx` holds `activeFlow` in `useState` and calls `.controller.submit(q)` (`chat.tsx:170`) — it is a thin dispatcher, not the state machine. If the `step` transitions, the parsing, and the session calls lived inline inside the React component (the way `chat.tsx`'s own `busy` guard and `/exit` handling do, per `audit.md` lens 3), this pattern wouldn't be available — you'd be back to driving a fake terminal. **Extract the interactive loop as a pure, side-effect-free-except-for-injected-dependencies state machine, and multi-turn conversation testing becomes exactly as easy as reducer testing.** That's the transferable move, independent of OpenTUI, React, or this codebase.

---

## Primary diagram

```
  Scripted multi-turn flow test — full picture

  ┌─ test ────────────────────────────────────────────────────────────┐
  │  const session = makeStubSession({ methodX: async (...) => {...} })│
  │  const flow = createResearchFlow(session, topic, {})               │
  │  await flow.start()                     → assert step             │
  │  await flow.submit(input_1)             → assert step, call count │
  │  await flow.submit(input_2)             → assert step, call count │
  │  ...                                     → assert captured payload │
  └───────────────────────────┬──────────────────────────────────────┘
                              │ drives
  ┌─ flow (closure state machine) ─────────▼───────────────────────────┐
  │  step: 'prediction'→'promote'→'stake'→'resolution'→'review-date'→'done' │
  │  local: collected, output, prediction, stake, resolutionCondition   │
  │  each submit(): validate → (re-prompt same step) | (advance + call) │
  └───────────────────────────┬──────────────────────────────────────┘
                              │ session.researchCollect/.researchEvaluate/.saveDecision/…
  ┌─ injected ChatSession stub ▼────────────────────────────────────────┐
  │  quiet no-ops for "don't care" methods                              │
  │  throw-if-called for "must never reach this" methods (review-flow)  │
  │  scripted return values for "this is what the test is about"        │
  └────────────────────────────────────────────────────────────────────┘
```

---

## Elaborate

This is the reducer-testing / state-machine-testing pattern (the same discipline XState's `machine.transition(state, event)` tests or a Redux reducer's `reducer(state, action)` tests exercise), applied here to a hand-rolled state machine rather than a library-backed one. buffr didn't reach for a state-machine library — `research-flow.ts` and `review-flow.ts` are both under 165 lines, plain `if`-chains keyed on a string `step` — and that's a reasonable size call: a library buys you visualizable transition tables and guards against illegal transitions, at the cost of a new dependency and a new vocabulary, for a conversation with five and six states respectively. If either flow grows branching (e.g., a "confirm before discard" sub-step) or a third flow appears with materially more states, revisiting that call is worth it; right now the plain closure is the simpler-is-better choice.

`parseDayCountOrDate` (`src/cli/parse-review-date.ts`) is shared between both flows — the same "N days from now, or an ISO date" parser backs the `/research` review-date step and the `/review` snooze-date step. Neither flow's test file re-derives that parsing logic; each just asserts the flow rejects an unparseable date at the right step (`research-flow.test.ts:176-189`, `review-flow.test.ts:94-106`) and accepts a valid one. That's appropriately scoped — the parser's own edge cases (is `"0"` valid? a past ISO date?) belong in a unit test of `parse-review-date.ts` directly, which does not currently exist; see `audit.md` lens 5's edge-case gap list, expanded here for this file specifically.

This pattern is also where three of the five bugs commit `41ecce8` fixed came from — see `audit.md` lens 3/7 for the full account of which of those five landed with a regression test and which didn't. The `research-flow` fix in that commit (the `PREDICTION_PROMPT` missing its score-explanation line) is copy-only and untestable as a `step` assertion; it's a reminder that this pattern proves the *state machine* is correct, not that every string it emits matches a spec.

---

## Interview defense

**Q: Why is this testable without mocking `stdin` or the terminal?**
Because the conversation logic isn't wired to a terminal at all — `createResearchFlow`/`createReviewFlow` return a plain object with two async methods, `start()` and `submit(input: string)`, that take a string and return `{ messages, step }`. `chat.tsx` is the only thing that ever connects that to real keystrokes; the test calls `submit()` directly with scripted strings, the same way a reducer test dispatches actions without a store. The extraction — pulling the state machine out of the component that renders it — is what makes this possible; it's a prerequisite, not a testing trick.

```
  what makes this testable

  chat.tsx (UNTESTED here)         research-flow.ts (TESTED here)
  ┌───────────────────────┐        ┌────────────────────────────┐
  │ <textarea> → keystrokes│ ─────► │ submit(input): Promise<..> │ ← test calls this directly
  │ real terminal I/O       │        │ no I/O of its own           │
  └───────────────────────┘        └────────────────────────────┘
```

*Anchor:* "The flow object has no I/O of its own — `submit()` takes a string and returns state, so a test can drive it exactly like a reducer, no terminal required."

**Q: Why does the stub session make some methods throw instead of just returning empty data?**
Because a silent no-op can't tell you "this method should never have been called from this flow." `review-flow.test.ts`'s stub wires `researchCollect`/`researchEvaluate` — methods that belong to the *other* flow — to `throw new Error('not used')`. If a future change accidentally made `review-flow` call one of those, a quiet stub would return `''` and the test might still pass by coincidence; the throwing stub turns that mistake into an immediate, loud failure at the exact call site. It's the same idea as a strict mock's "unexpected call" failure, done with a plain object instead of a mocking library.

*Anchor:* "Quiet stubs for 'don't care,' throwing stubs for 'must never happen' — the throw is the assertion that a wrong flow never reaches the wrong session method."

**Q: The `evaluateCalls` counter in the invalid-prediction test — isn't `assert.strictEqual(step, 'prediction')` after bad input enough?**
No, and this is the load-bearing detail people skip. Re-prompting at the same step proves the *user-facing* behavior is right, but it doesn't prove the *expensive* call (an LLM-backed `researchEvaluate`) didn't fire anyway on a rejected input — a flow could re-prompt AND leak a wasted model call in the same turn, and a step-only assertion would never catch it. Counting calls closes that gap: `evaluateCalls` must be `0` after each malformed input and exactly `1` after the first valid one.

*Anchor:* "Step-only assertions catch 'wrong prompt shown'; call-count assertions catch 'right prompt shown, wrong (expensive) thing happened anyway' — a strictly stronger check for anything gated behind a real model call."

---

## See also

- `01-env-gated-integration-tests.md` — the contrasting pattern for state that genuinely needs a live dependency (Postgres); flow tests need none.
- `02-fake-embedder-injection.md` — the same "swap the real dependency for an injected fake at a typed interface" discipline, applied to `EmbeddingProvider` instead of `ChatSession`.
- `audit.md` lens 3 — `chat.tsx`'s own untested logic (the `busy` guard, `/exit`, the error turn) is what's *left* on the wrong side of this extraction — the flows escaped the untestable seam; the rest of the component didn't.
- `audit.md` lens 7 — the fuller account of which of commit `41ecce8`'s five bug fixes got a regression test.
