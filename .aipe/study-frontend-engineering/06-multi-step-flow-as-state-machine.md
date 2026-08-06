# Multi-step flow as a state machine — the `activeFlow` union

**Industry name(s):** finite state machine (FSM) driving a wizard/multi-turn UI · "conversational form" · state machine hoisted out of the component. **Type:** Industry-standard pattern (FSM-as-UI-controller), project-specific: the machine lives in a plain factory object, not a React reducer or a library like XState.

---

## Zoom out, then zoom in

Every command in buffr used to be one request, one response, one turn — `session.ask()`, await, append, done. `/research` and `/review` broke that shape: they need to ask you several questions in sequence (predict a score, then decide discard/hypothesis/decision, then stake, then resolution condition, then a review date) and each answer determines what gets asked next. Here's where that machinery sits.

```
  Zoom out — where the flow state machine lives

  ┌─ UI layer ────────────────────────────────────────────────┐
  │  <Chat>: activeFlow useState                               │
  │    ★ THIS CONCEPT: activeFlow.controller ★                 │ ← we are here
  │    routes EVERY keystroke to controller.submit() while set │
  └───────────────────────────┬──────────────────────────────┘
                  controller.start()/.submit(input)
  ┌─ Flow layer ───────────────▼──────────────────────────────┐
  │  research-flow.ts / review-flow.ts                         │
  │    closed-over step + collected data, own transition table │
  └───────────────────────────┬──────────────────────────────┘
                  session.researchEvaluate() / .saveDecision() / …
  ┌─ Data layer ───────────────▼──────────────────────────────┐
  │  ChatSession (session.ts) → engines, PgJournalStore         │
  └──────────────────────────────────────────────────────────┘
```

**Zoom in:** the concept is a **finite state machine driving a multi-turn UI conversation** — sometimes called a "wizard" pattern on the web (multi-step signup forms, checkout flows), except here every "screen" is just a chat turn and the "form fields" are free-text answers parsed per step. The machine's states are `ResearchFlowStep` (`'prediction' | 'promote' | 'stake' | 'resolution' | 'review-date' | 'done'`, `research-flow.ts:8`) and `ReviewFlowStep` (`'action' | 'snooze-date' | 'disposition' | 'note' | 'done'`, `review-flow.ts:5`). `<Chat>` never sees these enums — it only ever calls `start()` or `submit(input)` and renders `result.messages`.

---

## The structure pass

One axis: **"who decides what happens on the next keystroke?"** Trace it from the component down into the flow object and watch it flip.

```
  Axis — "who decides what the next input means?" — traced down

  ┌─ <Chat> (chat.tsx:154-191) ────────────┐
  │  decides: is a flow active at all?      │   → ROUTING decision only
  │  (activeFlow null or not)               │
  └────────────────┬────────────────────────┘
        ═══════════╪═══════════  ◄── seam: activeFlow.controller.submit()
  ┌─ flow controller (research-flow.ts) ▼──┐
  │  decides: which STEP am I on, what does │   → INTERPRETATION decision
  │  this input mean for that step?         │
  └──────────────────────────────────────────┘
```

- **Layers:** the component (routes input to a flow or to slash-command dispatch) → the flow controller (interprets input against its current step) → the data layer (persists once the flow reaches a terminal action).
- **Axis (control):** `<Chat>` makes exactly one decision about a flow: "is `activeFlow` set?" Everything past that — what "72 frequency 60" means, whether "decision" is a valid answer at this point, what the *next* prompt should be — is decided entirely inside the controller. `<Chat>` is control-blind past the seam, the same way it's backend-blind past the `ChatSession` seam in `04-session-as-the-data-layer.md`.
- **The seam:** the `ResearchFlow`/`ReviewFlow` interface — two methods, `start()` and `submit(input: string)`, both returning `Promise<{ messages: string[]; step: … }>`. It's a *narrower* contract than `ChatSession`: no callbacks, no options bag, just "here's raw text, tell me what to say back and whether you're done."

Hand off to mechanics with that seam named.

---

## How it works

### Move 1 — the mental model

You've built this shape before, even if not with this vocabulary: a multi-step signup form where step 2's validation depends on what was submitted in step 1, and the component holding the form doesn't hardcode "if step === 2, render the address fields" — it delegates to whatever the current step object says to render next. The novelty here isn't the FSM; it's that the "screens" are chat turns and the "component" is a closure, not a React component.

```
  Pattern — closure-held FSM, polled by request/response

  ┌────────┐  submit(input) ┌──────────────┐  submit(input) ┌─────────┐
  │ step A │ ─────────────► │   step B     │ ─────────────► │  done   │
  └────────┘                └──────────────┘                └─────────┘
      ▲                            │
      │ private vars (score,       │ each submit():
      │ stake, resolutionCondition)│  1. reads current `step`
      │ live INSIDE the closure,   │  2. validates input against it
      │ invisible to the caller    │  3. mutates `step` + private vars
      └────────────────────────────┘  4. returns { messages, step }
```

The strategy in one sentence: **build the machine as a closure over mutable local variables, expose only `start`/`submit`, and let the step value returned each call tell the caller when to stop routing.**

### Move 2 — the walkthrough

#### The kernel — closed-over state plus a step-keyed `if` chain

```ts
// src/cli/research-flow.ts:73-159 (structure, condensed)
export function createResearchFlow(session: ChatSession, topic: string, callbacks: ResearchFlowCallbacks): ResearchFlow {
  let step: ResearchFlowStep = 'prediction';        // ← the machine's state
  let collected: CollectedResearch | null = null;   // ← accumulated across steps
  let output: MarketResearchOutput | null = null;
  let prediction: ResearchPrediction | null = null;
  let stake = '';
  let resolutionCondition = '';

  return {
    async start(): Promise<ResearchFlowResult> { /* fetch evidence, prompt for a prediction */ },
    async submit(input: string): Promise<ResearchFlowResult> {
      if (step === 'prediction') { /* parse score/dimension/confidence, call researchEvaluate, step = 'promote' */ }
      if (step === 'promote')    { /* discard | hypothesis | decision → step = 'done' or 'stake' */ }
      if (step === 'stake')      { /* capture stake text, step = 'resolution' */ }
      if (step === 'resolution') { /* capture condition text, step = 'review-date' */ }
      // step === 'review-date' — parse date, call session.saveDecision(), step = 'done'
    },
  };
}
```

Six local variables, closed over by two methods, is the entire machine. Bridge from what you know: this is a `useReducer`'s `(state, action) => newState` shape, minus React — `step` is the state, `submit(input)` is the dispatch, and the big `if` chain is the reducer's switch. The difference that matters: because this isn't React state, **nothing outside the closure can read `step` directly.** The only way to know where the flow is is to call `submit()` and read `.step` off the *result*. That's a deliberate narrowing of the interface, not an oversight — `<Chat>` genuinely doesn't need to know.

#### Step by step — one prompt, one parse, one transition

**`prediction` → `promote`:** `start()` fetches evidence via `session.researchCollect(topic)` and, if any was found, returns a prompt asking the user to predict a score/dimension/confidence *before* buffr reveals its own read (`research-flow.ts:82–90`). `submit()` at this step calls `parsePrediction(input)` (`research-flow.ts:44–54`) — a hand-rolled three-token parser (`"<score> <dimension> <confidence>"`) that returns `null` on any malformed input, in which case `submit()` **does not advance the step** — it returns the same `step: 'prediction'` with a "could not parse that" message. This is the load-bearing validation gate: a failed parse is a no-op transition, not an error path. Bridge: it's exactly a controlled form input rejecting invalid input on blur and re-showing the field, except the "field" is the next chat turn.

**`promote` → `stake` or `done`:** three valid answers (`discard`, `hypothesis`, `decision`) branch three ways — `discard` and `hypothesis` both terminate the flow (`step = 'done'`) after a side effect (`hypothesis` calls `session.saveHypothesis()`); `decision` continues the machine into three more steps (`stake` → `resolution` → `review-date`) before finally calling `session.saveDecision()`. Any other input re-prompts without transitioning, same discipline as the prediction parse.

**`review-date` → `done`:** the terminal step reuses `parseDayCountOrDate` (`src/cli/parse-review-date.ts`), a tiny shared parser (`"<N>"` days-from-now or an ISO date string, both required to resolve to a future timestamp) — the same function `review-flow.ts` uses for its `snooze-date` step. One parser, two flows, extracted specifically because both needed identical "day-count-or-ISO-date, must be future" semantics (commit `d30a529`).

```
  Layers-and-hops — one submit() round trip

  ┌─ <Chat> (chat.tsx:166-189) ──────────┐  hop 1: q (raw text)
  │  activeFlow.controller.submit(q)     │ ───────────────────────►
  └───────────────────────────────────────┘
  ┌─ research-flow.ts submit() ──────────┐  hop 2: session.researchEvaluate()
  │  parse input against current step    │ ───────────────────────► (only on 'prediction' step)
  │  mutate step + closure vars           │
  └───────────────────────────────────────┘  hop 3: { messages, step }
  ┌─ <Chat> renders result ──────────────┐ ◄───────────────────────
  │  setTurns(...result.messages)         │
  │  if (result.step === 'done') clear    │
  │  activeFlow; else keep it set          │
  └───────────────────────────────────────┘
```

#### The `<Chat>` side — routing, not interpreting

```tsx
// chat.tsx:154-191
const handleSubmit = (): void => {
  const q = (taRef.current?.plainText as string | undefined)?.trim() ?? '';
  if (busy) return;
  if (!activeFlow && !q) return;
  taRef.current?.setText('');

  if (activeFlow) {
    if (q.toLowerCase() === '/cancel') {
      setTurns(t => [...t, { role: 'you', text: q }, { role: 'buffr', text: 'Cancelled.' }]);
      setActiveFlow(null);
      return;
    }
    setTurns(t => [...t, { role: 'you', text: q }]);
    setBusy(true);
    activeFlow.controller.submit(q).then(
      result => {
        setTurns(t => [...t, ...result.messages.map(text => ({ role: 'buffr' as const, text }))]);
        setBusy(false);
        if (result.step === 'done') setActiveFlow(null);
      },
      err => { setTurns(t => [...t, { role: 'buffr', text: `error: ${(err as Error).message}` }]); setBusy(false); setActiveFlow(null); },
    );
    return;
  }
  // ... normal slash-command dispatch below, only reached when activeFlow is null
```

Two things worth naming precisely. First, `/cancel` is checked **before** anything is forwarded to the controller — it's a UI-level escape hatch the flow objects don't know exists; `<Chat>` just drops `activeFlow` back to `null` and never calls `submit('/cancel')`. Second, `if (result.step === 'done') setActiveFlow(null)` is the **entire** lifecycle management for the flow — one line, checked after every `submit()`. `<Chat>` doesn't hold a switch over `ResearchFlowStep` values; it only cares about the one terminal value, `'done'`, treating every non-`'done'` step identically ("keep routing input here"). That's the payoff of the narrow contract: five states in `research-flow.ts`, and the component only ever branches on one of them.

### Move 2 variant — the load-bearing skeleton

Strip this to the irreducible core: **a mutable step variable + a step-keyed transition function + a caller that only inspects the terminal value.** Name each part by what breaks without it:

- Drop the **closure-private step variable** (make it a parameter passed in and out) → `<Chat>` would need to hold `ResearchFlowStep` in its own `useState` and pass it back on every `submit()` call — the interpretation logic leaks upward into the component, exactly the coupling `04-session-as-the-data-layer.md` shows the `ChatSession` seam prevents for the backend.
- Drop the **non-advancing failure branch** (always transition, even on unparseable input) → a single fat-fingered "72 fequency 60" (typo) skips straight to `promote` with `prediction = null`, and the next step's `saveDecision()` call would throw on a null dereference instead of re-prompting.
- Drop the **single terminal-state check** in `<Chat>` (`result.step === 'done'`) → the component would need a full switch over every intermediate step just to decide "should I clear `activeFlow`," reintroducing the coupling the narrow contract was built to avoid.

Optional hardening not present: no way to go *back* a step (only forward or `/cancel` to abandon entirely), no persistence of in-progress flow state across a crash (if the process dies mid-flow, the closure and everything in it is gone — the flow restarts from scratch on the next `/research <topic>`).

### Move 3 — the principle

A state machine doesn't need a library to earn the name — it needs an explicit current-state variable, an explicit transition function, and a caller that treats the state as opaque except for the values it actually needs to act on. Buffr's version is a plain closure because the FSM has no concurrent instances, no need for time-travel debugging, and a caller (`<Chat>`) that only ever inspects one bit of it (`done` or not). The moment either flow needs to run two instances at once, resume across a restart, or have its transitions inspected from outside, that's the trigger to reach for something heavier (XState, a `useReducer` with a persisted state) — not before.

---

## Primary diagram

The full path: routing at the component, interpretation in the closure, persistence at the terminal transition.

```
  buffr's flow-as-state-machine — full path

  ┌─ <Chat> (chat.tsx:128-191) ──────────────────────────────────┐
  │  activeFlow: { kind, controller } | null                      │
  │  routes: /cancel → clear · anything else → controller.submit()│
  │  reads only: result.step === 'done' ?                         │
  └───────────────────────────┬───────────────────────────────────┘
                  submit(input) / start()
  ┌─ Flow controller (research-flow.ts / review-flow.ts) ▼────────┐
  │  step: 'prediction'→'promote'→'stake'→'resolution'→           │
  │        'review-date'→'done'   (research)                      │
  │  step: 'action'→'snooze-date'|'disposition'→'note'→'done'      │
  │        (review, with 'action' also looping back on 'keep')     │
  │  private vars: prediction, stake, resolutionCondition, …       │
  └───────────────────────────┬───────────────────────────────────┘
                  session.researchEvaluate() / saveDecision() /
                  saveHypothesis() / snoozeReview() / resolveReview()
  ┌─ Data layer (session.ts → PgJournalStore) ▼────────────────────┐
  │  agents.decisions — the persisted record, written ONLY at       │
  │  the terminal transition of each flow, never mid-flow           │
  └────────────────────────────────────────────────────────────────┘
```

---

## Elaborate

This is the same pattern web wizards, CLI installers (`npm init`), and conversational chatbot slot-filling all reach for — a step enum plus a transition function, wrapped in whatever mechanism the platform makes cheapest. On the web that's often a `useReducer` or a routing library (one URL per step); as a CLI installer it's usually a loop with `readline` prompts; buffr's version is the loop, just expressed as `await`ed `submit()` calls gated by the terminal's own input loop (`useKeyboard` → `handleSubmit`). The reason it's a plain closure and not `useReducer`: the flow's state doesn't need to trigger a *component* re-render on every transition — it only needs to exist between two `submit()` calls, and the caller re-renders anyway because `setTurns`/`setBusy` fire regardless. Reaching for `useReducer` here would mean re-deriving the same step machine twice (once inside `research-flow.ts`'s closure, once as a reducer) for no benefit.

Read next: `07-streaming-progress-panel.md` (the progress events `researchEvaluate` streams *during* the `prediction`-step transition) and `04-session-as-the-data-layer.md` (the same narrow-contract-over-a-factory shape, one layer down). `study-testing` for why this is currently zero-tested surface — the parse functions (`parsePrediction`, `parseDisposition`, `parseDayCountOrDate`) are pure and trivially unit-testable; the flow objects need a fake `ChatSession` the same way `<Chat>` does.

---

## Interview defense

**Q: "Where does the state for a multi-step `/research` conversation live, and why isn't it in `useState`?"**

It's a closure inside `createResearchFlow`, referenced through one `useState<{ controller } | null>` in `<Chat>`. The component never needs to know which of the five internal steps the flow is on — it only routes input to `submit()` and checks one bit of the result (`step === 'done'`). Putting the step enum in component state would mean `<Chat>` has to switch on all five values just to decide whether to keep routing there; keeping it in the closure means the interpretation logic never leaks past the `start()`/`submit()` seam.

```
  where the step LIVES vs where it's READ
  step enum:       closure-private, inside research-flow.ts
  <Chat> reads:    only result.step === 'done' — one bit, not five states
```

Anchor: *"`activeFlow.controller` is a two-method object closing over its own step variable — same narrow-contract shape as `ChatSession`, one layer up (research-flow.ts:73 vs session.ts:34)."*

**Q: "What's the load-bearing part people get wrong when they build this?"**

Letting a failed parse still advance the state. `parsePrediction` returning `null` on `"72 fequency 60"` (typo) must **not** transition `step` past `'prediction'` — if it does, the next step runs with `prediction = null` and either crashes or silently records garbage. The re-prompt-without-transitioning branch is the part that's easy to skip when the happy path is all you tested.

```
  the mistake vs the fix
  wrong:  parse fails → transition anyway → null flows downstream → crash later
  right:  parse fails → step stays put → same prompt shown again
```

---

## See also

- `04-session-as-the-data-layer.md` — the same narrow-contract-over-a-factory seam, one layer down (`ChatSession` vs `ResearchFlow`/`ReviewFlow`)
- `03-async-ui-with-a-busy-flag.md` — the rejection-handling fix (`26f0e4b`) applied to this flow's `submit()`/`start()` calls
- `07-streaming-progress-panel.md` — what streams live during the `prediction`-step's `researchEvaluate()` call
- `audit.md` lens 2 (state-architecture: `activeFlow`), lens 5 (routing-and-navigation: the soft-modal input router), red flag #1 (`handleSubmit` size), red flag #6 (no cancellation mid-flow)
- cross-link: `study-system-design` (where `agents.decisions` persists), `study-testing` (zero coverage on the parse functions and flow objects)
