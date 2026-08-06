# Live Progress Panel

**Industry name(s):** progress events / job-step status stream, "live pipeline telemetry" (the shape a CI run page or a build log uses) — *Industry-standard* UX pattern, *Project-specific* implementation over a plain callback chain (no event bus, no WebSocket).

`/research` and `/investing` run a four-stage pipeline (Collector → Analyzer → Scorer → Teacher) that can take 10–30 seconds. Instead of one spinner that says "researching…" for the whole span, buffr now fires a typed `ProgressEvent` for every sub-step — each connector fetch, each capability stage — and the chat UI renders them live as a per-step list with individual state (running / done / failed / skipped). This is a real, working instance of exposing internal pipeline state to the person operating it while the pipeline is still running.

---

## Zoom out, then zoom in

Here's the whole thing. You've watched a GitHub Actions run page: each job starts gray, goes yellow-and-spinning, then flips to a green check or a red X — and you can tell *which* job is slow before the whole run finishes. That's what this pattern builds, in a terminal, for a research pipeline that has no CI system underneath it.

```
  Zoom out — where the progress panel lives

  ┌─ Capability layer (packages/capabilities/collector) ─────────┐
  │  Collector.execute() → onEvent() per connector as it settles │ ← finest-grained signal
  └────────────────────────────────┬──────────────────────────────┘
                                    │  CollectorEvent (generic: start/done/failed)
  ┌─ Engine layer (engine-market-research) ─▼─────────────────────┐
  │  MarketResearchEngine.collect()/evaluate()                    │
  │  translates + adds engine-start / stage-start / stage-done    │ ★ THIS CONCEPT ★
  └────────────────────────────────┬──────────────────────────────┘
                                    │  ProgressEvent (domain-specific, labeled)
  ┌─ Session + flow layer (src/session.ts, research-flow.ts) ─────▼─┐
  │  pure passthrough — onProgress bounced through unchanged        │
  └────────────────────────────────┬──────────────────────────────┘
                                    │  same ProgressEvent, same shape
  ┌─ UI layer (src/cli/chat.tsx) ──▼───────────────────────────────┐
  │  ProgressEvent → ProgressStep (owns state) → StepList render   │ ← we are here
  └──────────────────────────────────────────────────────────────┘
```

Zoom in. The question this pattern answers: *while a 10-30 second pipeline is running, can the person watching tell what's happening right now, and which step (if any) is stuck?* The pattern is **fire an event per sub-step, own an ordered list of step-state in the UI, patch entries by id as events arrive**. Four layers carry the event; only the last one has anything to do with it.

## The structure pass

**Layers:** Collector (emits) → Engine (translates + adds stages) → session/research-flow (passthrough) → chat.tsx (owns state, renders).

**Axis — "who owns the accumulated list of steps?"** Trace it down:

```
  One question down the layers: who owns the step list?

  ┌──────────────────────────────────────────────┐
  │ Collector.execute()                           │  → STATELESS
  │   onEvent() fires once per connector, no memory│    (fire and forget)
  └───────────────────────┬───────────────────────┘
  ┌───────────────────────▼───────────────────────┐
  │ MarketResearchEngine.collect()/evaluate()     │  → STATELESS
  │   translates CollectorEvent → ProgressEvent    │    (relay + label)
  └───────────────────────┬───────────────────────┘
  ┌───────────────────────▼───────────────────────┐
  │ session.ts / research-flow.ts                 │  → STATELESS
  │   onProgress passed straight through           │    (pure plumbing)
  └───────────────────────┬───────────────────────┘
       seam: the reducer   │  ═══ the axis FLIPS here ═══
  ┌───────────────────────▼───────────────────────┐
  │ chat.tsx: updateProgressSteps()               │  → STATEFUL
  │   owns the array; patches entries by id        │    (the only owner)
  └────────────────────────────────────────────────┘
```

**The load-bearing seam is the last hop.** Three layers of pure plumbing exist for one reason: to get a typed event from where it's *known* (inside `Collector.execute`, mid-`Promise.all`) to the one place that's allowed to *own state about it* (`chat.tsx`). There's a second, smaller seam worth naming too — where `Collector`'s generic `{type, sourceId}` event becomes the engine's domain-specific, human-labeled `ProgressEvent` (`packages/engines/market-research/src/engine.ts:80-88`). That's a translation seam: the Collector doesn't know what "Google Trends" is, only that source `discovery.google-trends` started or finished; the engine is where the id becomes a label a human reads.

## How it works

#### Move 1 — the mental model

You've seen a CI run page: each job starts as an empty gray row, flips to a spinner when it starts, then to a check or an X when it finishes — and jobs you haven't reached yet aren't drawn at all. buffr's progress panel is that same shape, built from scratch with four discriminated-union event types and a React array.

```
  The shape — event stream → per-step state machine

  ProgressEvent stream:      per-step state (owned in chat.tsx):

  engine-start    ──────►    ◆ Market Research Engine
  connector-start ──────►    ⎿ ⠋ Google Trends            (running)
  connector-start ──────►    ⎿ ⠋ Reddit                   (running)
  connector-done  ──────►    ⎿ ✓ Google Trends · 8 results (done)
  connector-failed──────►    ⎿ ✗ Reddit                    (failed)
  stage-start     ──────►    ⎿ ⠙ Analyzer · Gemma          (running)
  stage-done      ──────►    ⎿ ✓ Analyzer · 4 findings     (done)

  each *-start APPENDS a new row; each *-done/*-failed PATCHES
  the existing row by id — never a full re-render of the list
```

The mechanism in one sentence: every event either appends a new step or patches an existing one by `id`, and a step's terminal state (`done`/`failed`/`skipped`) is permanent once set.

#### Move 2 — the step-by-step walkthrough

**Where the finest-grained signal is born.** `Collector.execute()` used to run all sources through one `Promise.all` and report back only when everything settled. It now takes an `onEvent` callback and fires it at each connector's own start and finish, inside the same `Promise.all` (`packages/capabilities/src/collector/index.ts:35-52`):

```
  packages/capabilities/src/collector/index.ts:35   await Promise.all(
  :36     input.sources.map(async (source) => {
  :37       onEvent?.({ type: 'start', sourceId: source.connector.id });
  :38       try {
  :39         const result = await source.connector.fetch(source.params);
  :42         onEvent?.({ type: 'done', sourceId: source.connector.id, count: evs.length });
  :43       } catch (err) {
  :46         onEvent?.({ type: 'failed', sourceId: …, reason, optional: … });
  :50   }));
```

Read the boundary condition: because this is *inside* the `map`, not after it, a fast connector's `done` event can land while a slow one is still `running` — which is the entire point. Without this (reporting only after the outer `Promise.all` resolves) the panel could never distinguish "all three sources are running" from "two finished two seconds ago and the third is hanging."

**Where the translation happens.** `MarketResearchEngine.collect()` wraps each per-source `Collector.execute()` call with a closure that maps the generic `CollectorEvent` to a labeled, domain-specific `ProgressEvent` (`packages/engines/market-research/src/engine.ts:76-89`, types at `packages/engines/market-research/src/types.ts:18-24`):

```
  packages/engines/market-research/src/engine.ts:80   onEvent: progress ? (e) => {
  :81     if (e.type === 'start') {
  :82       progress({ type: 'connector-start', id: e.sourceId, label });   // label from friendlyName()
  :83     } else if (e.type === 'done') {
  :84       progress({ type: 'connector-done', id: e.sourceId, label, count: e.count });
  :86       progress({ type: 'connector-failed', id: e.sourceId, label, optional: e.optional });
  :88   } : undefined,
```

The engine also emits event types the Collector has no concept of — `engine-start` once at the top of `collect()` (`:60`), and `stage-start`/`stage-done` around Analyzer, Scorer, and Teacher inside `evaluate()` (`:138`, `:148`, `:155`, `:160`, `:164`, `:178`). `stage-start` for Analyzer and Teacher carries `model: this.modelId` (`:138`, `:164`) — the source of the "· Gemma" tag in the panel — while Scorer's `stage-start` omits it (`:155`), because Scorer is pure code, not a model call.

**The passthrough hops.** `session.ts` doesn't touch the event at all — `researchCollect()` forwards `opts?.onProgress` straight into `researchEngine.collect()` (`src/session.ts:723`), and `researchEvaluate()` does the same into `.evaluate()` (`:740`). `research-flow.ts`'s controller does the same again, forwarding the whole `callbacks` object — which includes `onProgress` — into both `session.researchCollect()` (`src/cli/research-flow.ts:83`) and `session.researchEvaluate()` (via `callbacks` at `:104`). Three files, zero logic. That's not incidental — it's what "the chat UI is the only stateful layer" (the structure-pass axis) looks like in code.

**Where the event becomes UI state.** `chat.tsx` is where the seam flips. `onProgress` is a `switch` over the six `ProgressEvent` tags that either appends a new `ProgressStep` or patches an existing one by `id` (`src/cli/chat.tsx:273-293`):

```
  src/cli/chat.tsx:273   onProgress: (event: ProgressEvent) => {
  :274     if (event.type === 'engine-start') {
  :275       updateProgressSteps(s => [...s, { id: '__engine__', label: event.label, kind: 'engine', state: 'running' }]);
  :276     } else if (event.type === 'connector-start') {
  :277       updateProgressSteps(s => [...s, { id: event.id, label: event.label, kind: 'connector', state: 'running' }]);
  :278     } else if (event.type === 'connector-done') {
  :279       updateProgressSteps(s => s.map(step => step.id === event.id
  :280         ? { ...step, state: 'done', detail: … } : step));
  ...
  :286     } else if (event.type === 'stage-start') {
  :287       updateProgressSteps(s => [...s, { id: event.id, label: event.label, kind: 'stage', state: 'running', model: event.model }]);
  :288     } else if (event.type === 'stage-done') {
  :289       updateProgressSteps(s => s.map(step => step.id === event.id
  :290         ? { ...step, state: 'done', detail: … } : step));
  :292   },
```

`*-start` always appends (`[...s, newStep]`); `*-done`/`*-failed` always finds-and-patches by `id` (`s.map(step => step.id === event.id ? {...} : step)`). No entry is ever removed — a failed connector stays visible as a red `✗` row for the rest of the run, which is exactly what you want in a diagnostic panel: the failure doesn't scroll away.

**Why there's both a `useState` and a `useRef` for the same list.** `updateProgressSteps` (`src/cli/chat.tsx:146-152`) writes to both `progressSteps` (React state, drives the re-render) and `progressStepsRef.current` (a plain mutable mirror):

```
  src/cli/chat.tsx:146   const updateProgressSteps = (updater) => {
  :147     setProgressSteps(prev => {
  :148       const next = updater(prev);
  :149       progressStepsRef.current = next;   // ← the mirror
  :150       return next;
  :151     });
  :152   };
```

This isn't redundancy — it's a fix for a real bug class. When `controller.start().then(result => …)` finally resolves (`:295-308`), that callback closed over `progressSteps` *at the time it was created*, which is stale by the time the promise settles seconds later — a classic React stale-closure trap. Reading `progressStepsRef.current` instead gets the *current* array so the "freeze whatever's still `running` to `done`" step (`:297`) sees every step that actually happened, not just the ones that existed when `.then()` was registered.

**The steps-stick-to-the-turn trick.** When the pipeline finishes, the frozen step list is attached to the resulting `buffr` turn as `progressSteps` (`:303`), and the render for a *completed* turn checks that field (`:416-418`), separately from the *live* `ProgressPanel` shown only `{busy && …}` (`:431`). This is the fix for a real regression (`ebe1e65`): without it, `progressSteps` — the live-render state — clears the moment `busy` flips to `false`, and the whole per-step trail vanishes from the transcript the instant the answer arrives. Attaching a *copy* to the turn is what makes the trail part of the conversation's scrollback instead of a transient overlay.

#### Move 2 variant — the load-bearing skeleton

The irreducible kernel, named by what breaks without each part:

1. **Per-item events fired from inside the parallel loop**, not after it (`collector/index.ts:37,42,46`, inside the `Promise.all` `map`). Drop this and you're back to one spinner for the whole batch — you lose the entire "which one is stuck" answer this pattern exists to give.
2. **A translation layer that adds labels the source event doesn't have** (`engine.ts:76-89`, `friendlyName()` at `:37-48`). Drop it and the panel reads `discovery.google-trends` instead of `Google Trends` — technically complete, practically unreadable.
3. **Append-on-start, patch-by-id-on-done** (`chat.tsx:273-293`). Replace this with "just re-render the latest snapshot" and you either lose completed steps when a new one starts, or duplicate a step if two events for the same id race.
4. **The ref mirror alongside the state** (`chat.tsx:136,146-152`). Drop it and the "freeze running steps to done" logic in the `.then()` handler silently freezes a stale, shorter list — steps that started late would never get marked `done`, only vanish.
5. **Turn-attachment on completion** (`chat.tsx:297,303,416-418`). Drop it and the entire trail is a live-only overlay — gone the instant the pipeline finishes, which is exactly the bug `ebe1e65` fixed.

Optional hardening layered on top: the frame-based spinner ticker in `ProgressPanel` (`chat.tsx:96-104`) — a `setInterval` that advances an animation frame independent of new events arriving, so a step that's been `running` for four seconds without a new event still looks alive instead of frozen mid-glyph. Nice for perceived responsiveness; not load-bearing for correctness.

**The boundary condition worth knowing before you trust this panel as a debugging tool: it's live-only, not durable, and it doesn't cover every model call it appears to.** Two concrete gaps:

- **No row in `agents.messages` for anything the panel shows.** `AgentContext` (the object every `Capability.execute()` receives, `packages/contracts/src/index.ts:1`) carries only a `traceId: string` — a label, not a `CapabilityTraceSink`. `Analyzer.execute()` and `Teacher.execute()` both call `runAgentLoop({...})` without a `trace` option (`packages/capabilities/src/analyzer/index.ts:115-123`, `packages/capabilities/src/teacher/index.ts:100-…`), so `trace?.emit(...)` inside `run-agent-loop.ts` is always a no-op for these calls. The moment a `/research` turn finishes, the *only* record of what the Analyzer's prompt said or what the model returned is whatever's still in terminal scrollback — contrast this hard with `01-full-signal-trajectory-capture.md`, where the exact same `runAgentLoop` kernel, wired with `trace`, durably persists every `model_usage` and `step` event for the chat path.
- **The live token counter is wired but dead during `/research`.** `session.ts`'s `researchEvaluate()` sets `currentOnTokens = opts?.onTokens` (`src/session.ts:729`) — the same module-level slot the `trace` wrapper's `model_usage` branch feeds (`:612-617`). But since Analyzer/Teacher never emit `model_usage` (no `trace` passed in), that branch never fires during `/research`, so `currentOnTokens` is called zero times. The `ProgressPanel`'s `· N tok` suffix (`chat.tsx:110-111`) simply never renders during `/research` — not a crash, a silently no-op feature that looks wired end-to-end and isn't.

#### Move 3 — the principle

**A live progress signal and a durable trace answer different questions, and building one doesn't give you the other.** The progress panel answers "what's happening right now" for the person watching; a persisted trace answers "what happened" for someone who wasn't. buffr built the first one well for `/research` and already had the second one for `/ask` — but they're separate investments, wired independently, and the codebase currently has the live one without the durable one on this path. Naming which question a given observability mechanism actually answers — instead of assuming "there's a progress panel" implies "there's a trace" — is the transferable lesson.

## Primary diagram

```
  Live progress panel — the full event path, one /research turn

  Collector                Engine                  Session/Flow           chat.tsx
  ─────────                ──────                  ────────────           ────────
  onEvent{start}   ──────► translate ─────────────► passthrough ────────► append step (running)
  (per connector,          (id→label,                (onProgress           ◆ engine + ⎿ connector
   inside Promise.all)      add engine/stage          bounced through,        rows accumulate live
                            events Collector           no logic)
                            doesn't know about)

  onEvent{done}    ──────► translate ─────────────► passthrough ────────► patch step by id (done)
                                                                             ✓ Google Trends · 8

  (Analyzer/Teacher runAgentLoop calls — NO trace param passed)
       │
       └─ stage-start/stage-done DO fire (engine-level) ──────────────► ⎿ Analyzer · Gemma (running→done)
       └─ model_usage / step CapabilityEvents do NOT fire ──────────► agents.messages: NOTHING WRITTEN
                                                                        currentOnTokens: NEVER CALLED

  on pipeline settle: freeze remaining 'running' → 'done' via progressStepsRef
                       attach frozen array to the completed turn (progressSteps)
                       → survives busy:false, visible in scrollback (fixed by ebe1e65)
```

## Elaborate

This pattern is the UI-facing sibling of `01-full-signal-trajectory-capture.md`'s durable trace — both are "make internal pipeline state observable," aimed at different consumers. The trace table is built for someone debugging *after* the fact with a database client. The progress panel is built for the person sitting at the terminal *while* it runs — closer to a progress bar than a log, and it earns its keep the moment a pipeline takes long enough (10-30s here) that "nothing happened for a while" becomes ambiguous between "still working" and "hung."

The four-hop passthrough (Collector → Engine → session → research-flow → chat.tsx) is worth noticing as a *design cost*, not just plumbing: every new pipeline stage that wants to report progress has to be wired through all four layers by hand — there's no shared event bus a new capability can just publish onto. That's a reasonable tradeoff at buffr's current scale (one pipeline, one UI), and it's exactly the kind of thing that stops being reasonable the moment a second concurrent pipeline needs the same panel.

Where it connects: `01-full-signal-trajectory-capture.md` owns the durable trace this pattern doesn't have on the `/research` path; `03-stdout-as-only-log.md` owns what happens when *neither* a trace nor a progress panel exists (the plain CLIs). `study-frontend-engineering` owns the React state-management mechanics (the ref-mirror-for-stale-closures technique) as a general pattern; this file owns it as the specific fix for this specific bug.

## Interview defense

**Q: Walk me through what happens, end to end, when a connector fails during `/research`.**

```
  failure path — from fetch() throw to a red row that stays

  connector.fetch() throws
        │
  Collector catches (collector/index.ts:43-49)
        │  onEvent({type:'failed', sourceId, reason, optional})
        ▼
  engine.collect() translates (engine.ts:85-87)
        │  progress({type:'connector-failed', id, label, optional})
        ▼
  chat.tsx patches by id (chat.tsx:282-285)
        │  state: optional ? 'skipped' : 'failed'
        ▼
  StepList renders  ⎿ ✗ Reddit   (red, permanent — never removed)
```

The Collector catches the throw and turns it into a `failed` event carrying whether the source was `optional` (`collector/index.ts:43-49`); the engine relabels it; `chat.tsx` patches that step's `state` to `'skipped'` if optional, `'failed'` otherwise (`:282-285`) — and because patches never delete rows, that red `✗` stays visible for the rest of the run instead of disappearing when the next stage starts. **Anchor:** the `optional` flag riding all the way from `Collector.execute()`'s catch block to the step's terminal color.

**Q: What's the load-bearing part people miss when they first read this code?**

The `progressStepsRef` mirror (`chat.tsx:136,146-152`) sitting next to `progressSteps` state looks like dead duplication — until you trace why the "freeze running steps to done" logic (`:297`) doesn't read `progressSteps` directly. It's escaping a stale closure: the `.then()` callback on `controller.start()` was created when the array was still empty, and by the time it fires, `progressSteps` in that closure is frozen at creation time — only the ref sees the array as it actually ended up. **Anchor:** `progressStepsRef.current = next;` inside `updateProgressSteps` (`:149`) — the one line that makes the freeze-on-completion step correct.

**Q: Does this progress panel mean `/research` is as debuggable as `/ask`?**

No, and naming that gap precisely is the strongest answer. `/ask` goes through `RagQueryAgent`, which *is* wired with `trace` (`session.ts`'s `agent = new RagQueryAgent({ model, …, trace })`), so every `model_usage`/`step`/`tool_call_*` event lands in `agents.messages`. `/research`'s Analyzer and Teacher call the identical `runAgentLoop` kernel but never receive a `trace` option (`analyzer/index.ts:115-123`), so none of their model calls are durably recorded — the progress panel shows you the *shape* of the run live, but once it's over, nothing survives except what's on screen. **Anchor:** the missing `trace:` field in Analyzer's `runAgentLoop({...})` call — the same kernel, wired for two different observability outcomes.

## See also

- `01-full-signal-trajectory-capture.md` — the durable trace this pattern's sibling mechanism builds for `/ask`; the file that names the gap this one exposes for `/research`.
- `03-stdout-as-only-log.md` — what's left when neither a trace nor a progress panel exists.
- `audit.md` lens 1 (observability-map, the /research row set) and lens 8 (red flags: the untraced Analyzer/Teacher calls, the dead token counter).
- Cross-guide: `study-frontend-engineering` (the ref-mirror-for-stale-closures technique as a general React pattern), `study-agent-architecture` (`runAgentLoop`, the shared kernel both `/ask` and `/research` build on top of).
