# 00 — Overview: the frontend layer of buffr-laptop

One page. If you skim only this file, you know what the UI is.

## The rendering mode, in one sentence

It's a **client-side React app whose host is the terminal, not the browser** —
Ink reconciles a React tree and paints it as text to stdout, repainting the
whole frame on every state change. No SSR, no hydration, no virtual-DOM-to-real-DOM;
the "DOM" is the terminal screen.

## The whole UI in one diagram

The entire frontend surface is two files. `chat.tsx` is the view; `session.ts`
is the data layer it talks to. Everything below `session.ask()` is somebody
else's guide.

```
  buffr-laptop — the frontend layer and where it stops

  ┌─ Terminal (the host) ─────────────────────────────────────┐
  │  stdin (raw-mode TTY)        stdout (text frames)          │
  └────────┬──────────────────────────────▲───────────────────┘
           │ keypresses                    │ paint
  ┌─ UI layer  src/cli/chat.tsx ───────────┴───────────────────┐
  │  <Chat session> ── useState: turns / input / busy          │
  │     TextInput (controlled)   Spinner (busy)   turns.map()  │
  └────────┬───────────────────────────────────────────────────┘
           │  session.ask(q)  ◄── the ONE data seam
  ┌─ Data layer  src/session.ts ───────────────────────────────┐
  │  ChatSession { ask, close }                                │  ← frontend
  │  builds: pool · embedder · store · pipeline · tool ·       │     guide
  │          model · profile · memory · agent · trace          │     STOPS
  └────────┬───────────────────────────────────────────────────┘     here
           │  (agent loop, retrieval, Ollama HTTP, pg wire)
           ▼
   study-system-design · study-runtime-systems · study-networking
```

The line that matters: **the UI knows exactly one thing about the backend —
that `session.ask(string)` returns a `Promise<string>`.** It doesn't know there's
a pg pool, an Ollama model, a vector store, or an agent loop. That ignorance is
the whole design, and it's pattern `02`.

## The state architecture, in one diagram

Three pieces of local component state. No store, no context, no URL state, no
form library. This is `useState` in its purest form.

```
  state graph — all of it lives in <Chat>, src/cli/chat.tsx:11-13

  ┌──────────────────────────────────────────────────────────┐
  │ turns:  Turn[]    the transcript      append-only         │
  │                   { role:'you'|'buffr', text }            │
  │ input:  string    the in-progress     controlled by       │
  │                   text field          TextInput           │
  │ busy:   boolean    is a turn in        gates input ↔       │
  │                    flight?             spinner             │
  └──────────────────────────────────────────────────────────┘

  one transition (onSubmit) touches all three:
    input → ''           (clear the field)
    turns → [...t, you]  (echo the question)
    busy  → true         (swap input for spinner)
       … await session.ask …
    turns → [...t, buffr](append the answer)
    busy  → false        (swap spinner back for input)
```

## The three highest-leverage patterns

Ranked by what you'd lose if you stripped them out:

1. **`02-the-session-as-the-data-layer`** — `src/session.ts` + the single
   `session.ask()` call at `chat.tsx:28`. Strip it and the view would have to
   construct a pg pool, an embedder, a vector store, a model, and an agent
   inside a React component. This is container-vs-presentational discipline,
   and it's the most load-bearing decision in the UI.

2. **`04-async-ui-with-a-busy-flag`** — the `busy` flag at `chat.tsx:13` and
   the spinner at `chat.tsx:48-57`. Strip it and the terminal freezes silently
   for the seconds an LLM turn takes, with no feedback and no guard against a
   double-submit.

3. **`01-react-without-the-dom`** — the Ink reconciler. The `<Box>`/`<Text>`
   primitives, `jsx: react-jsx`, the `render()` call at `chat.tsx:63`. Strip it
   and there's no React at all — you're back to `console.log` and `readline`.

The other two (`03-hooks-state-in-a-cli`, `05-controlled-text-input`) are the
mechanics those three rest on.

## What's not here

`audit.md` does the full sweep, but the headline: **routing, CSS/styling,
client-side HTTP fetch, the browser platform (Storage/Worker/etc.), and the
bundler/deploy artifact are all `not yet exercised`.** This is a terminal app
built straight from `tsc`. Don't go looking for a Vite config or a stylesheet —
there isn't one, and that's correct for what this is.
