# Session as the data layer — the container/presentational seam

**Industry name(s):** container/presentational split · smart vs dumb components · data-layer façade · dependency injection via props. **Type:** Industry-standard pattern, project-specific: the façade is a plain object, not a component.

---

## Zoom out, then zoom in

`<Chat>` renders. `createChatSession` knows about Postgres, Ollama, the agent, the embedder, and memory. The two are joined by exactly one method call. Here's the seam — it's the single most important boundary in this frontend, because it's the one that keeps the UI free of backend concerns.

```
  Zoom out — the seam between presentation and data

  ┌─ Presentation (UI layer) ────────────────────────────┐
  │  <Chat>  (src/cli/chat.tsx)                           │ ← presentational
  │    knows: turns, input, busy, how to render            │
  │    knows NOTHING about pg / agent / Ollama            │
  └───────────────────────────┬──────────────────────────┘
        ════════════════════════╪═══  ◄── THE SEAM: session.ask()
  ┌─ Data layer (the container) ▼────────────────────────┐
  │  createChatSession()  (src/session.ts:34)            │ ← smart
  │    warm pg Pool · embedder · store · pipeline · tool  │
  │    · model · profile · memory · agent · trace sink    │
  └───────────────────────────┬──────────────────────────┘
                  pg · HTTP    │
  ┌─ Storage / Provider ──────▼──────────────────────────┐
  │  Postgres + pgvector  ·  Ollama (gemma2)              │
  └───────────────────────────────────────────────────────┘
```

**Zoom in:** the concept is the **container/presentational split** — keep the component dumb about *where data comes from*, push all acquisition behind a façade it merely calls. The façade here is `ChatSession`, a two-method object (`ask`, `close`) injected into `<Chat>` as a prop (`src/cli/chat.tsx:9`). The component awaits `session.ask(q)` and renders the string back. It never imports `pg`. That decoupling is the whole pattern.

---

## The structure pass

One axis: **"who knows about the backend?"** Trace it across the seam and it flips hard — full ignorance on one side, full knowledge on the other. That clean flip is what makes the seam load-bearing.

```
  Axis — "knows the backend exists?" — across the seam

  ┌─ <Chat> (presentational) ─────┐
  │  imports: ink, react,         │   → NO: knows only session.ask(): Promise<string>
  │  TextInput, Spinner, session  │
  └───────────────┬───────────────┘
        ══════════╪══════════  ◄── seam: the ChatSession contract
  ┌─ createChatSession ▼──────────┐
  │  imports: pg pool, embedder,  │   → YES: owns the entire pipeline
  │  store, agent, trace, memory  │
  └───────────────────────────────┘
```

- **Layers:** the component (renders) → the façade contract (`ChatSession`) → the data layer (pg/agent/Ollama).
- **Axis (knowledge of the backend):** `<Chat>` knows *nothing* — its only data import is `session` and the `ChatSession` type (`chat.tsx:5`). Cross the seam and `createChatSession` knows *everything* — nine collaborators wired in `session.ts:39–57`.
- **The seam:** the `ChatSession` type (`src/session.ts:29–32`) — a contract of two async methods. It's a **deep module** seam: a tiny interface (`ask`/`close`) hiding a large implementation (warm pool, agent loop, trace flush, memory write). The interface depth argument is owned by `study-software-design`; here we care that it lets the UI stay testable and dumb.

---

## How it works

### Move 1 — the mental model

You've drawn this seam a hundred times: a "container" component that fetches and a "presentational" one that just renders props. The twist here is that the container isn't a component at all — it's a plain factory that returns an object you inject. Same boundary, lighter mechanism.

```
  Pattern — dumb view, smart façade, one contract between

   ┌──────────────┐   session prop (DI)   ┌──────────────────┐
   │   <Chat>     │ ◄──────────────────── │ createChatSession │
   │ (renders)    │                       │  (wires backend)  │
   │              │ ── session.ask(q) ──► │                   │
   │              │ ◄── Promise<string> ─ │                   │
   └──────────────┘                       └──────────────────┘
       knows only the contract                owns everything
```

The strategy in one sentence: **the component depends on a narrow contract, not on the backend; the backend is constructed once and injected, so the view can't see past the seam.**

### Move 2 — the walkthrough

#### The contract — two async methods, nothing else

```ts
// src/session.ts:29–32
export type ChatSession = {
  ask(question: string): Promise<string>;
  close(): Promise<void>;
};
```

This type *is* the seam. Bridge from what you know: it's the prop interface of a presentational component — the only surface the view is allowed to touch. Everything the data layer does (persist, retrieve, generate, trace, remember) collapses into `ask(): Promise<string>`. The view can't reach a pg client through this type even if it tried; the contract physically hides it.

#### The container — wired once, off the render path

```ts
// src/session.ts:34–57 (condensed)
export async function createChatSession(): Promise<ChatSession> {
  const pool = createPool(cfg.databaseUrl);                    // warm pg pool
  const embedder = new OllamaEmbeddingProvider({ … });
  const store = new PgVectorStore({ pool, … });
  const pipeline = createRetrievalPipeline({ embedder, store });
  const tool = createSearchKnowledgeBaseTool(pipeline, { minTopK: 4 });
  const tools = new InMemoryToolRegistry([tool.definition], { … });
  const model = new ContextWindowGuardedProvider(new GemmaModelProvider({ … }), { maxTokens: 8192 });
  const profile = await loadProfile(pool, cfg.appId);
  const memory = createConversationMemory({ embedder, store });
  const conversationId = await startConversation(pool, cfg.appId);
  const agent = new RagQueryAgent({ model, tools, profile, trace });
  return { async ask(q) { … }, async close() { … } };
}
```

Nine collaborators, wired top to bottom, all **before** `<Chat>` ever renders — the factory is `await`ed at module load (`chat.tsx:62`) and the resulting object is handed in as a prop. This is the "smart" half: it owns construction order, the warm pool, the one long-lived conversation. The component sees none of it. Boundary condition: because this runs once at startup, the cost (pool warm-up, profile load) is paid before the UI appears, not per turn — that's deliberate (the long-lived session is the point; see `study-system-design`).

#### Injection — the seam crossed at the boundary

```tsx
// src/cli/chat.tsx:9, 62–63
function Chat({ session }: { session: ChatSession }) { … }   // receives the façade as a prop
// ...
const session = await createChatSession();   // construct the container
render(<Chat session={session} />);          // inject it
```

This is dependency injection, plain and direct: build the data layer outside the component, pass it in. Bridge: it's the same move as passing an `onSubmit` handler or a data prop down to a dumb child — the child declares what it needs (`{ session }`) and the parent supplies it. Because injection happens at the root, swapping the real `ChatSession` for a fake one in a test is a one-line substitution — the component never constructs its own dependency, so there's nothing to mock around.

#### The one call site

```tsx
// src/cli/chat.tsx:28
const answer = await session.ask(q);
```

That single line is every interaction the UI has with the entire backend. Persist, retrieve-augmented generation, trace flush, memory write — all of it is behind those eleven characters. The view's job ends at "await the string, render it."

### Move 2 variant — the load-bearing skeleton

The irreducible core: **a narrow contract + a factory that builds the impl + injection at the boundary.** Named by what breaks:

- Collapse the **contract** (let `<Chat>` import `createPool` directly) → the component now knows pg; you can't render it without a database, and the test must stand up Postgres.
- Drop **injection** (have `<Chat>` call `createChatSession()` itself) → the component owns its dependency's lifecycle; no fake session, no isolated render test.
- Drop the **factory** (inline the wiring into the component) → the nine collaborators and their construction order leak into the view; the deep module becomes a shallow mess.

Optional hardening not present: the contract is a hand-written type, not an interface with multiple implementations — there's one `ChatSession` today. That's fine; the seam is real because the *boundary* is enforced, not because there are two impls.

### Move 3 — the principle

The container/presentational split survives every framework rotation because it's not a React idea — it's **dependency inversion**: the high-level policy (render a conversation) depends on an abstraction (`ChatSession`), not on the low-level details (pg, Ollama, the agent). Buffr proves you don't need a "container component" to get it — a plain factory plus a prop is enough. The test that the seam is real: can you render `<Chat>` with a three-line fake session and no database? Here, yes — and that's the entire payoff.

---

## Primary diagram

The full seam: construction below, injection at the root, one call across.

```
  buffr's data seam — construct below, inject at root, one call across

  ┌─ entry (src/cli/chat.tsx:62–63) ────────────────────────┐
  │  const session = await createChatSession()              │
  │  render(<Chat session={session} />)        ── inject ──┐ │
  └────────────────────────────────────────────────────────┼─┘
  ┌─ Presentation: <Chat> ──────────────────────────────────▼┐
  │  receives { session } · renders turns/input/busy         │
  │  await session.ask(q)  ◄── the ONLY backend touch        │
  └───────────────────────────┬──────────────────────────────┘
        ════════════════════════╪═══  ◄── ChatSession contract (session.ts:29)
  ┌─ Data layer: createChatSession (session.ts:34) ▼─────────┐
  │  pool · embedder · store · pipeline · tool · model ·      │
  │  profile · memory · conversation · agent · trace          │
  └───────────────────────────┬──────────────────────────────┘
                  pg · HTTP    │
  ┌─ Storage / Provider ──────▼──────────────────────────────┐
  │  Postgres + pgvector  ·  Ollama (gemma2)                 │
  └───────────────────────────────────────────────────────────┘
```

---

## Elaborate

Container/presentational was Dan Abramov's 2015 framing; hooks later blurred the *component* version of it (you can `useQuery` inside a "presentational" component now). What didn't blur is the underlying principle — keep the view dumb about data acquisition. Buffr lands on the cleanest expression: the data layer is a plain async factory, injected once. The same seam is what lets the broader system swap the backend (the one-shot `ask` CLI vs this long-lived session) without touching the UI — and what lets `study-software-design` call `ChatSession` a deep module: maximal hidden implementation behind a minimal interface.

Read next: `03-async-ui-with-a-busy-flag.md` (the await around `ask()`) and `02-hooks-state-in-a-cli.md` (why `turns` is a projection of what lives below this seam). System-level ownership — the warm pool, the single conversation across turns — is `study-system-design`; the interface-depth argument is `study-software-design`.

---

## Interview defense

**Q: "Where's your data-fetching layer, and how does the UI stay testable?"**

Behind a façade. "`<Chat>` is presentational — it receives a `ChatSession` prop and only ever calls `session.ask()`. All the backend wiring lives in `createChatSession`, constructed once and injected at the root. To test the UI I pass a three-line fake session; no Postgres needed, because the component never constructs its own dependency."

```
  the seam, testability view
  <Chat>  ──session.ask()──►  ChatSession contract
                                  ├─ real: pg + agent + Ollama
                                  └─ fake: () => "stub answer"   ← test swaps here
```

Anchor: *"The component imports the `ChatSession` type, never `pg` — the contract physically hides the backend (chat.tsx:5 vs session.ts:39)."*

**Q: "Why a plain factory instead of a container component?"**

Because there's nothing to render in the container — it's pure construction. A component would add a render cycle and lifecycle for zero benefit. A factory returning an injected object is the lighter expression of the same dependency inversion. The load-bearing point: the pattern is the *boundary*, not the mechanism — container component, hook, or factory all achieve it; pick the lightest.

```
  same seam, three mechanisms
  container component │ custom hook │ plain factory  ← buffr
  all = "view depends on a contract, not the backend"
```

---

## See also

- `03-async-ui-with-a-busy-flag.md` — the await wrapping `session.ask()`
- `02-hooks-state-in-a-cli.md` — `turns` as a projection of state below the seam
- `01-react-without-the-dom.md` — the view that consumes this façade
- `audit.md` lens 3 (component-architecture)
- cross-link: `study-software-design` (`ChatSession` as a deep module), `study-system-design` (warm pool, long-lived conversation)
