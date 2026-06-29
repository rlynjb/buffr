# Hooks state in a CLI — the useState triad

**Industry name(s):** local component state · `useState` · client state (vs server state). **Type:** Industry-standard pattern (React hooks), project-specific shape (three hooks, one component).

---

## Zoom out, then zoom in

The entire client-side state graph of buffr is three `useState` calls in one component. No store, no context, no reducer. Here's where those three live in the larger picture — and the one split that's actually interesting: two of them are pure UI state, but the conversation's source of truth is *not* in React at all.

```
  Zoom out — where client state sits

  ┌─ UI layer ───────────────────────────────────────────┐
  │  <Chat>   ★ useState: turns · input · busy ★          │ ← we are here
  │           (display projection + ephemeral UI state)   │
  └───────────────────────────┬──────────────────────────┘
                  session.ask()│
  ┌─ Data layer ──────────────▼──────────────────────────┐
  │  ChatSession: the in-process conversation             │
  └───────────────────────────┬──────────────────────────┘
                  pg writes    │
  ┌─ Storage ─────────────────▼──────────────────────────┐
  │  conversations / messages  ← the CANONICAL record     │
  └───────────────────────────────────────────────────────┘
```

**Zoom in:** the concept is **client state vs server state**, the single most important distinction in frontend state architecture. `input` and `busy` are pure client state — they exist only to drive the UI and die with the process. `turns` is a **display projection of server state** — a local copy of what the DB durably holds, rebuilt empty each launch (`useState<Turn[]>([])`, `src/cli/chat.tsx:11`). Knowing which of your state is canonical and which is a disposable view is the question this lens answers.

---

## The structure pass

One axis: **"if the process dies right now, is this state lost?"** Trace it across the three hooks and the answer flips — and where it flips is the seam between client and server state.

```
  Axis — "survives a crash?" — across the three hooks

  ┌─ client state (in React) ─────────────────┐
  │  input  → NO  (cleared every submit)       │   ephemeral
  │  busy   → NO  (resets to false)            │   ephemeral
  │  turns  → NO  (display copy only)          │   projection
  └───────────────────────┬────────────────────┘
        ════════════════════╪═══  ◄── seam: persist boundary (session.ask)
  ┌─ server state (in Postgres) ▼─────────────┐
  │  messages rows → YES  (durable)            │   canonical
  └────────────────────────────────────────────┘
```

- **Layers:** ephemeral UI state (`input`, `busy`) → display projection (`turns`) → durable record (DB rows).
- **Axis (durability):** all three React hooks answer "lost on crash: yes." The DB answers "no." The boundary where that flips is `session.ask()` writing to `messages` (`src/session.ts:62`).
- **The seam:** the persist boundary. It tells you `turns` is *not* your source of truth — it's a cache of the durable log you happen never to read back. That's a deliberate choice (see `audit.md` red flag #2), and naming it is the lesson.

---

## How it works

### Move 1 — the mental model

You know the rule: state that two parts of the UI must agree on gets lifted; state only one part needs stays local. Here there's only one component, so *everything* is local by default — the interesting move isn't lifting, it's classifying each piece by **lifecycle and ownership**.

```
  Pattern — three hooks, three lifecycles

   input  ●───keystroke───●───keystroke───● submit→clear   (per-character)
   busy   ○────────────────████████████████──────────○      (per-turn span)
   turns  ▷──append you──────────────────append buffr──▷     (append-only log)
          │                                          │
          render reads all three every frame ────────┘
```

The strategy: **co-locate each piece of state at the lowest level that needs it, and tag it by lifecycle — keystroke, turn-span, or append-only history.**

### Move 2 — the walkthrough

#### `input` — controlled value, per-keystroke lifecycle

```tsx
// src/cli/chat.tsx:12, 24, 55
const [input, setInput] = useState('');
// ...
setInput('');                                          // cleared on submit (chat.tsx:24)
<TextInput value={input} onChange={setInput} … />      // React owns the value (chat.tsx:55)
```

`input` is the controlled value of the text field — React holds the string, the field renders it, `onChange` writes every keystroke back. Bridge from the browser: this is `<input value={x} onChange={e => setX(e.target.value)}>` verbatim; `ink-text-input` hands you the new string directly instead of an event. Lifecycle: born empty, mutated per keystroke, reset to `''` on submit. It never persists. (Full controlled-input mechanics: `05-controlled-text-input.md`.)

#### `busy` — boolean loading flag, per-turn lifecycle

```tsx
// src/cli/chat.tsx:13, 17, 26, 32
const [busy, setBusy] = useState(false);
if (busy) return;            // re-entrancy guard (chat.tsx:17)
setBusy(true);               // before the await (chat.tsx:26)
// ... finally:
setBusy(false);              // after, guaranteed (chat.tsx:32)
```

`busy` spans exactly one turn — true from just-before `await session.ask()` to the `finally`. It does two jobs: gates re-entry (`if (busy) return`, so a second submit while thinking is dropped) and drives the render branch (spinner vs input, `chat.tsx:48`). Boundary condition: `setBusy(false)` lives in `finally`, so it resets even when `ask()` throws — drop the `finally` and one error strands the UI on the spinner forever. (Full loading-state walk: `03-async-ui-with-a-busy-flag.md`.)

#### `turns` — append-only transcript, projection of server state

```tsx
// src/cli/chat.tsx:11, 25, 29, 31
const [turns, setTurns] = useState<Turn[]>([]);
setTurns((t) => [...t, { role: 'you',   text: q }]);       // your turn, immediately (chat.tsx:25)
setTurns((t) => [...t, { role: 'buffr', text: answer }]);  // answer, after await (chat.tsx:29)
setTurns((t) => [...t, { role: 'buffr', text: `error: …` }]); // or error (chat.tsx:31)
```

`turns` is the transcript. Two things to name. First, the **functional updater** `t => [...t, …]`: it reads the latest array and appends a new one (immutable update — never `t.push`). This matters because the answer append (`chat.tsx:29`) happens *after* an `await`, by which point `turns` may have changed; the functional form guarantees you append to the current value, not a stale closure capture. Your React instinct here is exactly right and load-bearing. Second, `turns` is a **display projection** — `useState<Turn[]>([])` starts empty every launch and is never hydrated from the persisted `messages`. The canonical conversation is the DB (`session.ts:62`); `turns` is a disposable view of it.

### Move 2 variant — the load-bearing skeleton

Strip this to the irreducible core: **three independent `useState` cells + one render that reads all three + functional updates for the append-only one.** Name each by what breaks if removed:

- Drop `busy` → no re-entrancy guard; a fast double-submit fires two overlapping `ask()` calls into one conversation, and the UI never shows a thinking state.
- Drop the **functional updater** on `turns` → the post-`await` append (`chat.tsx:29`) closes over a stale `turns`, and a rapid sequence can drop a turn off the transcript.
- Drop `input` as controlled state → the field becomes uncontrolled; you can't clear it on submit (`chat.tsx:24`) and React no longer owns the value.

Optional hardening (not in the skeleton): the DB persistence behind `turns`, the error-turn branch. The skeleton is just the three cells and disciplined updates.

### Move 3 — the principle

Frontend state architecture is mostly **classification, not machinery**. Before reaching for a store, ask of each piece: who needs it, how long does it live, and is it the source of truth or a view of one held elsewhere. Buffr needs no Redux because the answer for all three is "one component, short-lived, and the real record is in Postgres." The discipline that scales isn't "add a store" — it's keeping that classification honest as components multiply.

---

## Primary diagram

The three cells, their lifecycles, and the canonical record they sit above.

```
  buffr client state — the full picture

  ┌─ <Chat> (UI layer, src/cli/chat.tsx:11–13) ─────────────┐
  │                                                         │
  │  input ─keystroke→ setInput ─submit→ ''                 │  ephemeral
  │  busy  ─submit→ true ─finally→ false                    │  ephemeral
  │  turns ─append you→ … ─append buffr→ …  (functional)    │  projection
  │           │                                             │
  │     render reads all three → reconcile → terminal       │
  └───────────┼─────────────────────────────────────────────┘
              │ session.ask() persists below
  ┌─ Storage ▼──────────────────────────────────────────────┐
  │  agents.messages  ← canonical conversation (durable)     │
  └──────────────────────────────────────────────────────────┘
```

---

## Elaborate

The client-state / server-state split is the idea react-query and SWR institutionalized: server state is owned elsewhere (the server), cached on the client, and needs invalidation; client state is yours and ephemeral. Buffr hand-rolls the cheapest version — `turns` is a write-through display copy with no read-back and no invalidation, because for a single-user local CLI the cost of staleness is "restart shows an empty transcript," which is acceptable. The day buffr wants to show history on launch, the move is to hydrate `turns` from `messages` on mount — and *that's* when a fetch-cache library would start earning its place.

Read next: `03-async-ui-with-a-busy-flag.md` (the `busy` lifecycle in full) and `04-session-as-the-data-layer.md` (where the canonical state lives). System-level ownership of the conversation is `study-system-design`.

---

## Interview defense

**Q: "Three `useState` hooks and no store — is that a smell?"**

No — it's correctly scoped. There's one component and the conversation's source of truth is the database, not React. A store earns its place when state must be shared across distant components or survive navigation; neither exists here.

```
  when does a store earn its place?
  shared across components?  NO  → local state
  survives navigation?       NO  → local state
  IS the source of truth?    NO (DB is) → just a projection
  ⇒ three useState cells is right
```

Anchor: *"input and busy are ephemeral client state; turns is a display projection of the durable messages rows (chat.tsx:11 vs session.ts:62)."*

**Q: "Why functional updaters instead of `setTurns([...turns, x])`?"**

Because the answer append happens *after* an `await` (`chat.tsx:29`), so the closed-over `turns` may be stale. `t => [...t, x]` reads the latest committed value. The load-bearing point people miss: it's not style — under concurrent appends the plain form can **drop a turn**. Naming that you'd hit this specifically across the `await` boundary is the signal.

```
  why functional update across an await
  setTurns([...turns, x])   ← turns captured BEFORE await → stale → lost turn
  setTurns(t => [...t, x])  ← reads latest → safe
```

---

## See also

- `03-async-ui-with-a-busy-flag.md` — the `busy` lifecycle and `try/finally`
- `04-session-as-the-data-layer.md` — where canonical state lives
- `05-controlled-text-input.md` — `input` as a controlled value
- `audit.md` lens 2 (state-architecture), red flag #2 (display/canonical drift)
- cross-link: `study-system-design` (system-level state ownership)
