# Streaming progress panel — live per-step status (Claude Code style)

**Industry name(s):** streaming progress indicator · live status stream · step/event log UI (as seen in Claude Code's, Codex's, and CI runners' "running step N of M" panels). **Type:** Industry-standard pattern (progressive disclosure of an async pipeline's internal steps), project-specific: a typed `ProgressEvent` union pushed through a plain callback, rendered as an append-only step list plus a ticking header.

---

## Zoom out, then zoom in

The old spinner told you one thing: "thinking…", for however many seconds an `/investing` or `/research` call took. That's fine for a single model call. It stops being fine once a call is actually a **pipeline** — collect from four connectors, analyze, score, teach — and any one stage can be the slow one, or the one that silently failed. The progress panel replaces "thinking…" with a live, growing list of exactly what's running, what finished, what failed, and what it cost.

```
  Zoom out — where the progress panel sits

  ┌─ UI layer ──────────────────────────────────────────────┐
  │  <Chat>: progressSteps useState + progressStepsRef        │
  │    ★ <ProgressPanel><StepList> ★                          │ ← we are here
  │    renders LIVE while busy, freezes onto the turn after   │
  └───────────────────────────┬───────────────────────────────┘
                  onProgress(event: ProgressEvent)
  ┌─ Engine layer ──────────────▼──────────────────────────────┐
  │  MarketResearchEngine.collect()/.evaluate()                │
  │  (packages/engines/market-research/src/engine.ts)          │
  └───────────────────────────┬───────────────────────────────┘
                  per-connector settle · per-stage start/done
  ┌─ Capability layer ──────────▼──────────────────────────────┐
  │  Collector (fires per-connector, not batched) · Analyzer ·  │
  │  Scorer · Teacher                                            │
  └───────────────────────────────────────────────────────────┘
```

**Zoom in:** the concept is a **streaming progress indicator** — an async pipeline reports its own internal steps as they happen, instead of the caller inferring progress from a single elapsed-time counter. Buffr's version is a discriminated-union event type (`ProgressEvent`, `packages/engines/market-research/src/types.ts:18–24`) pushed through a plain callback (`onProgress`), reduced client-side into an ordered `ProgressStep[]` array, and rendered as a live checklist. You've seen the *rendered* version of this in Claude Code's own tool-call panel or a CI job's step-by-step log; the mechanism underneath — event union in, reduced array state out, rendered as icon + label + detail per row — is the transferable part.

---

## The structure pass

One axis: **"who decides a step exists?"** Trace it from the deepest capability up to the rendered row.

```
  Axis — "who decides a step exists, and when it's done?" — traced up

  ┌─ Capability (Collector/Analyzer/Scorer/Teacher) ─────┐
  │  DECIDES: "connector X just started/finished/failed"  │  → source of truth
  └───────────────────────┬─────────────────────────────┘
                  onProgress(event) — fire-and-forget, no return value
  ┌─ Engine (collect()/evaluate()) ──────▼────────────────┐
  │  DECIDES: wraps capability signals into ProgressEvent, │  → translation only
  │  adds engine-start/stage-start/stage-done framing       │
  └───────────────────────┬─────────────────────────────┘
                  onProgress(event) — same callback, forwarded
  ┌─ <Chat> (updateProgressSteps) ────────▼────────────────┐
  │  DECIDES: nothing about WHAT happened — only how to     │  → pure reduction
  │  fold each event into the displayed array                │
  └────────────────────────────────────────────────────────┘
```

- **Layers:** capability (the actual work: an HTTP fetch, a model call) → engine (orchestrates capabilities, emits typed events) → component (reduces events into rendered rows).
- **Axis (who decides a step exists):** authority over "what happened" lives entirely in the capability/engine layers. `<Chat>` has zero domain knowledge — it doesn't know what a "connector" or a "stage" *is*, it just knows how to turn five event shapes into an array mutation. This is the same "dumb view, smart source" split as `04-session-as-the-data-layer.md`, applied to a *stream* of events instead of one resolved value.
- **The seam:** the `ProgressEvent` union itself (`types.ts:18–24`) — six variants, each carrying exactly the fields the UI needs (`id`, `label`, optional `model`/`detail`/`count`/`optional`) and nothing about *how* to render them. That's the contract: the engine promises a closed set of shapes; the component promises to handle all six.

Hand off to mechanics with that seam named.

---

## How it works

### Move 1 — the mental model

You know `onProgress`/`onUploadProgress` callbacks from `XMLHttpRequest` or `fetch` upload streams — a callback fires repeatedly with partial information while one async operation is still in flight, and you reduce those calls into UI state (a progress bar's percentage). This is the same shape, except instead of one number climbing 0→100, each callback delivers a **discrete event describing one step of a multi-step pipeline**, and the UI reduces the event stream into a growing list rather than a single scalar.

```
  Pattern — event stream in, ordered array out

  onProgress(e1) ──► reduce ──► [ step1:running ]
  onProgress(e2) ──► reduce ──► [ step1:running, step2:running ]
  onProgress(e3) ──► reduce ──► [ step1:done,    step2:running ]
  onProgress(e4) ──► reduce ──► [ step1:done,    step2:done,   step3:running ]
                                          │
                                render reads the array every time it changes
```

The strategy in one sentence: **treat each progress event as a reducer action over an ordered array, keyed by a stable `id`, and let the render layer map array → rows.**

### Move 2 — the walkthrough

#### The event union — a closed contract, six shapes

```ts
// packages/engines/market-research/src/types.ts:18-24
export type ProgressEvent =
  | { type: 'engine-start'; label: string }
  | { type: 'connector-start'; id: string; label: string }
  | { type: 'connector-done';  id: string; label: string; count: number }
  | { type: 'connector-failed'; id: string; label: string; optional: boolean }
  | { type: 'stage-start'; id: string; label: string; model?: string }
  | { type: 'stage-done';  id: string; detail: string };
```

`engine-start` fires once, framing the whole run ("Market Research Engine"). `connector-*` fires per data source (Google, Reddit, RSS, …) as each one starts and settles — and settles **independently**, not as a batch: commit `03e3dbd` changed the Collector to call `onEvent` the instant each connector's fetch resolves, rather than waiting for `Promise.all` across all of them. `stage-*` fires per pipeline stage (Analyzer, Scorer, Teacher), optionally carrying a `model` id so the UI can show which model is doing the work (commit `4b18408`). Six variants is the entire vocabulary the UI has to handle — no wildcard "other" case, no free-form status string to parse.

#### The reduction — folding events into an array, with a ref mirror alongside

```tsx
// chat.tsx:136, 146-152
const [progressSteps, setProgressSteps] = useState<ProgressStep[]>([]);
const progressStepsRef = useRef<ProgressStep[]>([]);

const updateProgressSteps = (updater: (steps: ProgressStep[]) => ProgressStep[]): void => {
  setProgressSteps(prev => {
    const next = updater(prev);
    progressStepsRef.current = next;   // ← write the mirror in lockstep
    return next;
  });
};
```

`updateProgressSteps` is the single choke point every event reduction goes through — never a bare `setProgressSteps` call elsewhere in the file. It does two things per call: updates the `useState` (so the *live* render re-renders) and writes the same value into `progressStepsRef.current` (so a **later** read — after the async hop has resolved — sees the final value without a stale closure). Bridge from what you know: `useState`'s setter schedules a re-render but its *current* value is only reliably readable from the next render or from a functional updater; a ref's `.current` is synchronously readable from anywhere, including a `.then` callback created before the state finished changing. This is the same "stale value across an await" problem `02-hooks-state-in-a-cli.md` solves for `turns` with a functional updater — solved here with a ref instead, because the read site (freezing steps onto a finished turn) needs a *snapshot after the fact*, not an *update*.

#### The `onProgress` handler — six branches, one per event shape

```tsx
// chat.tsx:273-293 (condensed)
onProgress: (event: ProgressEvent) => {
  if (event.type === 'engine-start') {
    updateProgressSteps(s => [...s, { id: '__engine__', label: event.label, kind: 'engine', state: 'running' }]);
  } else if (event.type === 'connector-start') {
    updateProgressSteps(s => [...s, { id: event.id, label: event.label, kind: 'connector', state: 'running' }]);
  } else if (event.type === 'connector-done') {
    updateProgressSteps(s => s.map(step => step.id === event.id
      ? { ...step, state: 'done', detail: event.count > 0 ? `${event.count} result${event.count !== 1 ? 's' : ''}` : undefined }
      : step));
  } else if (event.type === 'connector-failed') {
    updateProgressSteps(s => s.map(step => step.id === event.id
      ? { ...step, state: event.optional ? 'skipped' : 'failed' }
      : step));
  } else if (event.type === 'stage-start') {
    updateProgressSteps(s => [...s, { id: event.id, label: event.label, kind: 'stage', state: 'running', model: event.model }]);
  } else if (event.type === 'stage-done') {
    updateProgressSteps(s => s.map(step => step.id === event.id ? { ...step, state: 'done', detail: … } : step));
  }
},
```

Two reduction shapes, matching the two kinds of event: `*-start` events **append** a new row (`[...s, newStep]`); `*-done`/`*-failed` events **find and mutate** an existing row by `id` (`s.map(step => step.id === event.id ? {...} : step)`). The `id` is what makes this work — `connector-start` and `connector-done` for the same source share an `id`, so the "done" event can locate and update the exact row the "start" event created, rather than appending a second row. This is a keyed reducer, the same discipline as React's `key={i}` for list reconciliation — except the key here is doing lookup inside a plain array reduction, not inside the reconciler.

#### The render — a live panel while busy, a frozen list once done

```tsx
// chat.tsx:63-84, 113-119, 416-418, 431
function StepList({ steps, frame = 0 }: { steps: ProgressStep[]; frame?: number }) {
  return (
    <>
      {steps.map((step, i) => step.kind === 'engine'
        ? <text key={i} fg="#888888" marginLeft={2}>◆ {step.label}</text>
        : <text key={i} fg={stepColor(step.state)} marginLeft={4}>
            ⎿ {stepIcon(step.state, frame)} {step.label}{modelTag}{detail}
          </text>
      )}
    </>
  );
}
// live, inside ProgressPanel, while busy:
{busy && <ProgressPanel status={status} tokens={liveTokens} steps={progressSteps} />}
// frozen, attached to the completed turn:
{t.progressSteps && t.progressSteps.length > 0 && <StepList steps={t.progressSteps} />}
```

`<StepList>` is deliberately **stateless and dumb** — it takes an array and an animation frame index, and maps to text rows. That statelessness is what lets it serve two different callers with two different data lifecycles: `<ProgressPanel>` passes it the *live*, still-mutating `progressSteps` state (animated icons, via `frame`); the finished-turn render passes it a *frozen* array baked onto `Turn.progressSteps` at the moment the flow resolved (no `frame` prop — defaults to `0`, so icons stop animating once frozen, since `state` on every step has already been flipped to `'done'`).

#### Freezing the live steps onto a finished turn — where the ref pays off

```tsx
// chat.tsx:295-308 (condensed, the /research success branch)
controller.start().then(
  result => {
    const steps = progressStepsRef.current.map(s => s.state === 'running' ? { ...s, state: 'done' as const } : s);
    setTurns(t => [
      ...t,
      ...result.messages.map((text, i) => ({
        role: 'buffr' as const,
        text,
        ...(i === 0 && steps.length > 0 ? { progressSteps: steps } : {}),
      })),
    ]);
    setBusy(false);
    if (result.step === 'done') setActiveFlow(null); else setActiveFlow({ kind: 'research', controller });
  },
  …
);
```

This is the commit `ebe1e65` fix — before it, `progressSteps` reset to empty the moment `busy` flipped `false` (the panel just unmounted, taking its data with it), which read as the step trace *vanishing* the instant the answer appeared — jarring, since Claude Code and Codex-style panels keep their trace visible after completion. The fix reads `progressStepsRef.current` (not the `progressSteps` state variable) at the exact moment the promise resolves, maps any step still `'running'` to `'done'` (defensive — a step that never got an explicit `stage-done` shouldn't display as perpetually spinning on a finished turn), and attaches the result to the **first** message of that turn (`i === 0`) as `Turn.progressSteps`. From then on that data lives inside `turns`, the append-only transcript — it survives the panel unmounting because it's no longer read from `progressSteps` state at all.

### Move 2 variant — the load-bearing skeleton

Strip this to the irreducible core: **a closed event union + a keyed array reducer + a ref mirror for post-await reads + a dumb list renderer used twice.** Name each by what breaks without it:

- Drop the **`id`-keyed lookup** (append every event as a new row) → `connector-done` would add a *second* row instead of updating the "running" row `connector-start` created; the panel shows duplicate entries per connector.
- Drop the **ref mirror**, read `progressSteps` state directly inside the `.then` → the closure captures whatever `progressSteps` was when `.then` was *registered* (usually `[]`, since it's registered before any events fire), not the final array — every finished turn would show an empty step list.
- Drop the **defensive `running` → `done` remap** at freeze time → any step whose `stage-done`/`connector-done` event never arrived (a silent failure in the engine, not surfaced as `connector-failed`) freezes onto the turn still showing an animated spinner icon that will never move again.
- Drop the **shared `<StepList>` component** (inline two separate renderers) → the live and frozen rendering logic drift apart the first time either one changes; today they're guaranteed identical because it's the same function.

Optional hardening not present: no timeout on an individual step (`connector-failed` only fires if the connector's own promise rejects — a connector that hangs forever shows `running` forever, with no client-side deadline), no retry affordance per failed step, no way to expand/collapse a long step list.

### Move 3 — the principle

Streaming progress is a translation problem, not a rendering problem: the hard part is picking an event vocabulary narrow enough that a dumb reducer can fold it into UI state, and wide enough that the reducer never needs a "misc" branch. Buffr's six-variant `ProgressEvent` union is that vocabulary — small enough to exhaustively handle in one `onProgress` callback, expressive enough to drive both a live spinner-per-step view and a permanent transcript record from the exact same reduction. The moment a new *kind* of event doesn't fit the union (needs a seventh variant), that's the signal the vocabulary needs to grow — not that the component needs a special case.

---

## Primary diagram

The full path: capability signal → engine event → reduced array → two renders (live and frozen).

```
  buffr's streaming progress panel — event to two renders

  ┌─ Capability (Collector/Analyzer/Scorer/Teacher) ────────────┐
  │  per-connector settle (not batched) · per-stage start/done   │
  └───────────────────────────┬────────────────────────────────┘
                  onEvent()    │  (packages/capabilities/src/collector/index.ts)
  ┌─ Engine (MarketResearchEngine.collect/evaluate) ▼────────────┐
  │  wraps into ProgressEvent · adds engine-start/stage framing   │
  └───────────────────────────┬────────────────────────────────┘
                  onProgress(event: ProgressEvent)
  ┌─ <Chat> reducer (chat.tsx:146-152, 273-293) ▼─────────────────┐
  │  updateProgressSteps: keyed append (*-start) or               │
  │  keyed mutate (*-done/*-failed)                                │
  │  writes BOTH setProgressSteps AND progressStepsRef.current     │
  └──────────────┬──────────────────────────────┬─────────────────┘
       live read  │                    frozen read (post-await)
  ┌─ <ProgressPanel> (busy) ▼──┐      ┌─ turns[i].progressSteps ▼──┐
  │  animated icons, frame tick │      │  static icons, baked once  │
  │  <StepList steps={live}/>   │      │  <StepList steps={frozen}/>│
  └──────────────────────────────┘      └─────────────────────────────┘
```

---

## Elaborate

This pattern is the client-side half of what OpenTelemetry spans and CI systems (GitHub Actions' step log, Buildkite) do server-side — a hierarchy of named steps, each with a start/end and a state, rendered as a live-updating tree. What buffr does *not* have is the server-side half of that story: there's no span export, no trace persisted independently of the chat transcript, no way to inspect a past run's progress trace outside the turn it's attached to. The `Turn.progressSteps` field is the entire persistence story, and it only survives as long as the in-memory `turns` array does (gone on process restart, per `02-hooks-state-in-a-cli.md`'s display-projection finding). If buffr ever wants to replay or audit a research run's timing after a restart, that's the trigger to persist `ProgressEvent`s the way `CapabilityTraceSink` already persists the model-call trajectory (`study-system-design`) — today it doesn't, because the transcript being ephemeral is an accepted tradeoff, not an oversight.

Read next: `06-multi-step-flow-as-state-machine.md` (the `/research` flow whose `prediction`-step transition is what generates this event stream) and `03-async-ui-with-a-busy-flag.md` (`ProgressPanel`'s own ticking clock is the direct descendant of the original `<Spinner>`). The event-loop mechanics of `setInterval`'s 100ms tick competing with `onProgress` callback frequency belong to `study-runtime-systems`; render-cost measurement at up to 10Hz belongs to `study-performance-engineering`.

---

## Interview defense

**Q: "Walk me through what happens between clicking `/research` and seeing the final answer, from a rendering perspective."**

Three concurrent update sources render into the same panel. "`onStatus` sets a one-line label. `onProgress` fires a typed event per pipeline stage — connector start/done/failed, stage start/done — each folded into an ordered `progressSteps` array via a keyed reducer: `*-start` appends a row, `*-done`/`*-failed` finds that row by `id` and mutates it. `<ProgressPanel>` renders that array live, with its own 100ms interval driving the spinner animation independent of when events actually arrive. When the whole flow resolves, I read the *ref* mirror of that array — not the state — freeze any still-running step to `done`, and attach it to the finished turn so it survives the panel unmounting."

```
  three clocks, one panel
  onStatus     → one string, replaced each call
  onProgress   → N typed events, reduced into an array
  setInterval  → 100ms tick, independent of both — just animates whatever's there
```

Anchor: *"`updateProgressSteps` is the one choke point that keeps `progressSteps` state and `progressStepsRef` in lockstep (chat.tsx:146) — read the ref after the await, not the state, or you get a stale empty array."*

**Q: "Why does the step list use a ref mirror instead of just reading the state at the right time?"**

Because the `.then` callback that needs the final array is *registered* before any `onProgress` events fire — it closes over `progressSteps` as it was at registration time (empty), and React doesn't retroactively update a closure's captured variable. A `useState` setter's *next* value is only visible to the next render or to a functional updater form (`setX(prev => ...)`), neither of which helps when you need to read the value from inside an *unrelated* `.then` callback after the state has already finished changing. A ref's `.current` is mutated synchronously and read synchronously from anywhere — that's the entire reason it exists here, and it's the load-bearing detail that separates "I used a ref" from "I used a ref because closures over `await` don't see live state."

```
  why a ref, specifically
  useState read in .then:  closes over value at REGISTRATION time → stale
  ref read in .then:       reads value at CALL time → always current
```

---

## See also

- `06-multi-step-flow-as-state-machine.md` — the `/research` flow whose steps generate this event stream
- `03-async-ui-with-a-busy-flag.md` — `ProgressPanel`'s ticking clock, descended from the original `<Spinner>`
- `02-hooks-state-in-a-cli.md` — the functional-updater fix for the same "stale value across an await" problem, solved there with a different technique
- `audit.md` lens 1 (rendering-and-reactivity: three concurrent clocks), lens 2 (state-architecture: `progressStepsRef`), lens 4 (data-fetching: the `onProgress` channel), red flag #3 (`progressStepsRef` as a manually-synced second source of truth)
- cross-link: `study-runtime-systems` (event-loop scheduling of the 100ms interval vs callback arrivals), `study-performance-engineering` (render cost at up to 10Hz), `study-system-design` (`CapabilityTraceSink` as the durable analogue this ephemeral trace does not yet have)
