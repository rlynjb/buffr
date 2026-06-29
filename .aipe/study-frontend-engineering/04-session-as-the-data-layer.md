# session-as-the-data-layer

*Container/data-layer seam · client-state vs canonical-state · Project-specific*

## Zoom out, then zoom in

In your browser apps the seam between "the component" and "the data" is usually a
`fetch()` URL or a react-query hook. Here it is a single object — `ChatSession` — handed to
`<Chat>` as a prop. The component knows nothing about Postgres, Ollama, the aptkit agent, or
the trace sink; it knows two methods, `ask` and `close`. That object *is* the data layer,
and the boundary between it and the component is the most interesting seam in this repo.

```
  Zoom out — the component / data-layer split

  ┌─ UI layer (terminal) ───────────────────────────────────────┐
  │  <Chat session={session}/>   src/cli/chat.tsx:9              │
  │   owns: turns / input / busy  (DISPLAY state)                │
  │   calls: session.ask(q)  ·  session.close()                 │
  └───────────────────────────────┬──────────────────────────────┘
                  ★ THE SEAM ★      │  ChatSession contract: { ask, close }
  ┌─ Data layer ──────────────────▼──────────────────────────────┐
  │  createChatSession()  src/session.ts:34   (CANONICAL state)   │ ← we are here
  │   warm pg pool · one held conversation · agent built once    │
  │   ask(): persist → answer → flush → remember                 │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  pg / Ollama / aptkit
  ┌─ Storage + model layer ───────▼──────────────────────────────┐
  │  Postgres + pgvector   ·   Ollama                            │
  └──────────────────────────────────────────────────────────────┘
```

**Zoom in.** Two patterns meet here. **Container/data-layer separation**: `<Chat>` is pure
presentation + local UI state; `ChatSession` is all the side effects. And **client-copy vs
canonical-copy**: `turns` (in the component) is a *display* mirror; the real record lives in
Postgres, written by `ask()`. The question: *who owns the truth about the conversation, and
what does the component actually hold?*

## Structure pass

One axis: **state — who owns it, where does it live, is it the source of truth?** This axis
makes the seam pop because state-ownership *flips* across it.

```
  One axis — "where's the source of truth?" — across the seam

  ┌─ <Chat>  chat.tsx:9 ──────────────────────────────────┐
  │  turns: Turn[]   → DISPLAY copy, never re-read from DB │  → not the truth
  └───────────────────────────────────────────────────────┘
            ═══════════ session.ask(q) ═══════════  (state-ownership flips here)
  ┌─ ChatSession  session.ts:34 ──────────────────────────┐
  │  messages / conversations in Postgres                 │  → the truth
  │  persisted every turn  (session.ts:62-67)             │
  └───────────────────────────────────────────────────────┘
```

- **Layers:** component (display state) → session contract (`ask`/`close`) → persistence
  (pg).
- **Axis:** state-ownership. Above the seam, `turns` is a throwaway display buffer. Below
  it, Postgres holds the canonical, replayable record. The *same conversation* has two
  representations and the seam is where ownership flips from "ephemeral UI" to "durable
  truth."
- **The load-bearing seam:** the `ChatSession` interface (`session.ts:29-32`), exactly two
  methods. It is a deep module in Ousterhout's sense — a one-line interface (`ask(q) →
  string`) hiding a warm pool, a held conversation, an agent loop, a trace sink, and a memory
  engine. *That narrow interface over a deep implementation is why `<Chat>` stays 64 lines.*

## How it works

### Move 1 — the mental model

You know the container/presentational split: a "smart" container does the data work and
passes plain data down to a "dumb" presentational component. Here the container work is
hoisted *out of React entirely* into a plain async factory, and the component receives the
result as a prop. The shape:

```
  The pattern — narrow interface, deep implementation

   <Chat>  ──calls──►  session.ask(q)  ─────────►  string
     │                       │
     │ knows only:           │ hides:
     │   ask(q) → string     │   pg pool, conversation id,
     │   close()             │   agent.answer(), trace.flush(),
     │                       │   memory.remember()
     ▼                       ▼
   64 lines, zero            76 lines, all the
   infra knowledge           side effects
```

The strategy: **the component holds display state and a reference to a deep data module; the
module holds the canonical state and every side effect.** The seam between them is two
method signatures.

### Move 2 — the walkthrough

#### The contract — two methods, defined as a type

```ts
// src/session.ts:29-32
export type ChatSession = {
  ask(question: string): Promise<string>;
  close(): Promise<void>;
};
```

This type *is* the seam. `<Chat>` imports it (`chat.tsx:5`) and takes it as a prop
(`chat.tsx:9`). Everything the component can do to the data layer is in these two lines. The
boundary condition: because the contract is this narrow, the entire data layer — pg, Ollama,
aptkit, the trace sink — could be swapped for an in-memory fake in a test, and `<Chat>`
wouldn't know. That substitutability is the payoff of a narrow seam.

#### The factory — built once, before mount

```tsx
// src/cli/chat.tsx:62-63
const session = await createChatSession();   // all the wiring happens here, once
render(<Chat session={session} />);          // component receives the ready object
```

`createChatSession()` (`session.ts:34`) does the expensive one-time setup *before* React
mounts: it opens the warm pg pool (`session.ts:39`), builds the embedder/store/pipeline/tool
(`session.ts:40-45`), constructs the model and agent (`session.ts:46-57`), and starts one
conversation (`session.ts:55`). All of this is hoisted out of the component so `<Chat>`
never re-runs it. The boundary condition: this is a top-level `await` (`chat.tsx:62`) — if
it throws (e.g. `DATABASE_URL` unset, `session.ts:37`), it rejects *before* `render()`, so
there is no rendered error state, just a crash. (`audit.md` red-flag 4.)

#### `ask()` — the four side effects behind one return value

From `<Chat>`'s view, `ask(q)` is one await that returns a string. Behind the seam it is
four ordered steps:

```ts
// src/session.ts:60-71
async ask(question: string): Promise<string> {
  await persistMessage(pool, conversationId, 'user', question);  // 1 write user turn (canonical)
  const answer = await agent.answer(question);                    // 2 run the RAG agent
  await trace.flush();                                            // 3 persist the trajectory
  try {
    await memory.remember({ conversationId, question, answer });  // 4 best-effort episodic memory
  } catch {
    // swallow: memory is best-effort, the turn already succeeded
  }
  return answer;
}
```

Walk it as a layers-and-hops — the one `await session.ask(q)` from the component fans into
four sinks:

```
  Layers-and-hops — one ask() call, four persistence hops

  ┌─ UI ─────────┐  await session.ask(q)   ┌─ ChatSession.ask()  session.ts:60 ─────┐
  │ <Chat>       │ ──────────────────────► │  hop 1 persistMessage → pg (user turn) │
  │ chat.tsx:28  │                         │  hop 2 agent.answer() → Ollama+pgvector│
  │              │                         │  hop 3 trace.flush()  → pg (trajectory)│
  │ setTurns     │  answer string          │  hop 4 memory.remember → pgvector      │
  │ (+buffr)  ◄──┤ ◄────────────────────── │        (best-effort, try/catch)        │
  └──────────────┘                         └────────────────────────────────────────┘
```

The key insight for the *frontend* seam: hop 1 writes the user turn to the database, and the
component *also* appends that same turn to `turns` (`chat.tsx:25`). Those are two independent
writes of the same fact — the component never reads the turn back from the DB. So `turns` is
a **write-through display copy**, and Postgres is canonical. They can diverge: if hop 1
succeeds but hop 2 throws, the catch in `<Chat>` (`chat.tsx:30`) shows an `error:` bubble
while the DB holds the orphaned user turn with no answer. (`audit.md` red-flag 1.) The
load-bearing decision worth naming: step 4 is wrapped in its own `try/catch` (`session.ts:64-69`)
so a memory-write failure *never* loses the answer the user is about to see — the answer is
already in hand by step 3.

#### `close()` — the teardown, called from `/exit`

```ts
// src/session.ts:72-74
async close(): Promise<void> {
  await pool.end();   // drain the warm pg pool
}
```

The component calls this on `/exit` or `/quit` *before* exiting Ink (`chat.tsx:18-21`):

```tsx
// src/cli/chat.tsx:18-22
if (q === '/exit' || q === '/quit') {
  await session.close();   // drain the pool first
  exit();                  // then tear down the Ink app
  return;
}
```

The ordering matters: `close()` before `exit()` so the pg pool drains cleanly before the
process tears down the render loop. The boundary condition: `exit()` (from `useApp()`,
`chat.tsx:10`) unmounts the Ink tree and returns control to the shell — it is the terminal
analog of unmounting the React root.

### Move 3 — the principle

**Keep the data layer out of the component, behind the narrowest interface that does the
job.** `<Chat>` is testable and tiny because all the side effects live behind `ask`/`close`.
And know which copy of your state is canonical: `turns` is for the eyes, Postgres is for the
record, and they are written separately on purpose. The general lesson — a deep module with a
narrow interface buys you a presentation layer that doesn't have to know how the sausage is
made, and a clear answer to "which copy is the truth" prevents the whole class of
client/server divergence bugs.

## Primary diagram

The full seam, both methods, both state copies, all four hops.

```
  session-as-the-data-layer — the complete frame

  ┌─ UI layer  src/cli/chat.tsx ─────────────────────────────────┐
  │  <Chat>  display state: turns / input / busy                 │
  │    onSubmit:  await session.ask(q)        :28                │
  │    /exit:     await session.close() → exit() :18-21          │
  └───────────────┬──────────────────────────────────────────────┘
       ChatSession │ contract  { ask, close }   session.ts:29-32
  ┌────────────────▼─────────────────────────────────────────────┐
  │  createChatSession()  src/session.ts:34  (built once :62)    │
  │    warm pool :39 · agent built once :57 · 1 conversation :55 │
  │                                                              │
  │    ask(q):  1 persistMessage  → pg   (canonical user turn)   │
  │             2 agent.answer    → Ollama + pgvector            │
  │             3 trace.flush     → pg   (trajectory)            │
  │             4 memory.remember → pgvector  (best-effort)      │
  │    close(): pool.end()                                       │
  └───────────────┬──────────────────────────────────────────────┘
                  │
  ┌───────────────▼──────────────────────────────────────────────┐
  │  Postgres + pgvector  —  the CANONICAL conversation record   │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

Hoisting the data layer into a plain factory rather than a `useEffect` + Context is a
deliberate choice that fits a single-screen CLI: there is exactly one consumer, the session
outlives every render, and it is built before mount, so there is nothing for an effect to
manage. In a browser SPA with multiple screens you would more likely wrap this in a Context
provider or a query client so any component could reach it — but that is solving a problem
this app doesn't have. The pattern that *would* change the shape: if a second screen needed
the same session, or if the conversation had to survive a remount, the factory would move
behind a provider. For one held conversation in one process, the prop is the honest seam.
The client/canonical split here is the frontend face of a system-design decision — see
`study-system-design` for the warm-pool-and-held-conversation architecture and why Postgres
is the source of truth.

## Interview defense

**Q: The component appends to `turns` AND the session writes to Postgres. Isn't that storing
the same thing twice?**

```
  turns (component)          messages (Postgres)
  ─────────────────          ───────────────────
  display copy               canonical record
  written on submit/answer   written by ask() hop 1+3
  never read back            replayable, full-signal
  lost on exit               durable across sessions
```

Yes, deliberately. `turns` is the *display* copy — it exists to paint the screen and is
thrown away on exit. Postgres is the *canonical* copy — the replayable, full-signal record.
The component never reads `turns` back from the DB; it's a write-through mirror. The honest
caveat is they can diverge: if the DB write of the user turn succeeds but the agent throws,
the screen shows an error while the DB holds an orphaned turn. Naming that divergence is the
signal you understand which copy is the truth. Anchor: *"`turns` is for the eyes, Postgres is
the record — two writes of the same fact, only one is canonical."*

**Q: Why is `memory.remember()` wrapped in its own try/catch when the whole `ask` could just
throw?**

Because by the time step 4 runs, the answer the user asked for is already computed (step 2)
and the trajectory is already persisted (step 3). A failure to write *episodic memory* is not
a reason to lose the answer the user is about to see — so it is swallowed (`session.ts:64-69`)
and `ask()` returns the answer anyway. It is a best-effort enrichment, ranked below the
turn's success. Naming that ordering — answer first, memory best-effort — shows you read the
failure model, not just the happy path. Anchor: *"memory is best-effort; the turn already
succeeded, so a memory-write failure can't be allowed to drop the answer."*

## See also

- `02-hooks-state-in-a-cli.md` — the `turns` display copy this file contrasts with the DB.
- `03-async-ui-with-a-busy-flag.md` — the `await` whose four hops this file unpacks.
- `00-overview.md` — the network-seam diagram.
- Cross-link: `study-system-design` — warm pool, held conversation, source-of-truth ownership.
- Cross-link: `study-software-design` — `ChatSession` as a deep module with a narrow interface.
