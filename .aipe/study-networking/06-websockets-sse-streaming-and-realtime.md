# WebSockets, SSE, Streaming, and Realtime

**Industry name(s):** long-lived connections / server-sent events /
token streaming / realtime transports. **Type:** Industry standard.

## Zoom out, then zoom in

This is the file where the honest answer is *none of it, yet* — and the
reason is precise and worth understanding. buffr's chat is **request →
wait → full response**. No WebSocket, no SSE, no token-by-token streaming.
The Ink spinner spins, `agent.answer()` resolves to one complete string,
and the whole answer appears at once. That's a real architectural choice
with a visible UX cost, not an oversight.

```
  Zoom out — where streaming WOULD live (but doesn't)

  ┌─ UI (Ink) ───────────────────────────────────────────────┐
  │  chat.tsx: <Spinner/> thinking…   then the WHOLE answer   │ ← ★ would
  └─────────────────────────────┬─────────────────────────────┘   stream
                                │  ONE Promise<string>            here, but
  ┌─ Orchestration ─────────────▼────────────────────────────┐   doesn't
  │  session.ask → agent.answer()  → resolves ONCE, complete │
  └─────────────────────────────┬─────────────────────────────┘
                                │  one HTTP req/resp
  ┌─ Ollama ─────────────────────▼───────────────────────────┐
  │  generates the full answer, returns it (no token stream  │
  │  consumed by buffr)                                       │
  └──────────────────────────────────────────────────────────┘
```

Zoom in. The concept is **realtime transports**: ways to deliver data
incrementally over a held-open connection (WebSocket = bidirectional, SSE =
server→client one-way, HTTP chunked streaming = response body arrives in
pieces). buffr uses *none* — it uses plain request/response. Understanding
this file is understanding *why one string and not a stream*, and what it
would take to change.

## Structure pass

**Layers.** UI (renders the answer) → orchestration (`agent.answer`) →
Ollama (generates). One axis tells the whole story.

**Axis — guarantees / "does data arrive incrementally or all at once?"**

```
  axis: "incremental or atomic delivery?"

  ┌─ chat.tsx render ──────────┐  → ATOMIC: spinner, then full text
  └────────────────────────────┘
  ┌─ session.ask return type ──┐  → ATOMIC: Promise<string>, one value
  └────────────────────────────┘
  ┌─ agent.answer() ───────────┐  → ATOMIC: resolves once, complete
  └────────────────────────────┘

  every layer agrees: atomic. there is no incremental seam anywhere.
```

**Seam.** Here the *absence* of a seam is the finding. A streaming app has
a seam where tokens flow incrementally (an async iterator, an
`EventSource`, a `ReadableStream`). buffr has no such seam — the return
type is `Promise<string>` top to bottom (`session.ts:29-30`,
`chat.tsx:28`). No place to intercept a partial result, because there are
no partial results.

## How it works

### Move 1 — the mental model

You know the difference between `const data = await fetch(url).then(r =>
r.json())` — one atomic value — and consuming a `ReadableStream` where you
`for await` chunks as they arrive. buffr is firmly the first kind. The
mental model is just: *fire one request, await one complete answer, render
it.* No stream to consume.

```
  Request/response vs streaming — buffr is the left shape

  buffr (atomic):                streaming (NOT here):
  ┌─────────┐                    ┌─────────┐
  │ ask(q)  │                    │ ask(q)  │
  └────┬────┘                    └────┬────┘
       │ await (spinner)              │ for await chunk:
       ▼                              │   render token…
  ┌─────────┐                         │   render token…
  │ full    │                         │   render token…
  │ string  │                         ▼
  └─────────┘                    (text grows live)
```

### Move 2 — walk the (non-)realtime path

**The return type is atomic, all the way up.** Trace the type of an
answer from bottom to top:

```
  the answer's type — atomic at every hop

  agent.answer(question)        → Promise<string>   (session.ts:62)
        │ awaited once
  session.ask(): Promise<string>                    (session.ts:29-30,60)
        │ awaited once
  chat.tsx onSubmit:
     const answer = await session.ask(q);           (chat.tsx:28)
     setTurns(t => [...t, { role:'buffr', text:answer }]); (chat.tsx:29)
        │
        ▼  one setState with the COMPLETE string — never appended to
```

There is no `for await`, no async iterator, no partial-append anywhere in
the chain. `session.ask` is typed `Promise<string>` (`src/session.ts:30`),
`agent.answer` is awaited as one value (`src/session.ts:62`), and the UI
sets the turn text once with the whole string (`src/cli/chat.tsx:28-29`).

**The UX cost is the spinner.** `chat.tsx:13` sets `busy = true` before
the await and back to `false` after. While busy, the UI renders
`<Spinner/> thinking…` (`chat.tsx:48-51`). For a 9B model generating a long
answer locally, that's potentially many seconds of an opaque spinner, then
the full answer drops in at once. A streaming UI would show tokens as they
generate — same total time, far better perceived latency. That's the
concrete cost of the atomic choice, paid on every turn.

```
  Move 2.5 — current state vs streaming future

  ┌─ NOW (atomic) ───────────┐   ┌─ IF STREAMED (not built) ──────┐
  │ busy=true                │   │ busy=true                      │
  │ <Spinner> thinking…      │   │ tokens append live:            │
  │   …(N seconds opaque)…   │   │   "The" "answer" "is" …        │
  │ setTurns(full string)    │   │ no opaque wait                 │
  │ busy=false               │   │ busy=false at [DONE]           │
  └──────────────────────────┘   └────────────────────────────────┘

  what would have to change: aptkit's GemmaModelProvider would need a
  streaming variant (consume Ollama's chunked/NDJSON stream), agent.answer
  would yield an async iterator instead of returning a string, session.ask
  would expose that, and chat.tsx would append per chunk instead of one
  setState. buffr can't add this without an aptkit-side change — aptkit is
  consumed, never edited here.
```

**Ollama can stream; buffr doesn't consume it.** Ollama's generate
endpoint supports a streaming response (NDJSON, one token-ish chunk per
line). aptkit's `GemmaModelProvider`, as buffr uses it, returns a complete
string — buffr awaits one value (`session.ts:62`). Whether aptkit requests
non-streaming or buffers the stream internally is aptkit's business; from
buffr's seam it's atomic either way. `not yet exercised`: buffr consuming
a token stream.

**WebSockets and SSE: structurally absent.** Both need a *server* holding
a connection open to push to a client. buffr has no inbound server (file
`01`) and no browser client, so there's no place for either. The Ink UI
"updates live" via React re-renders driven by local state, not by a pushed
network event. `not yet exercised`: WebSocket, SSE — and like CORS, not in
this shape ever.

**Reconnect logic: nothing to reconnect.** No long-lived push connection
exists, so there's no reconnect/backoff/heartbeat machinery. The one
long-lived thing is the pg *pool* (file `03`), but that's pooled
request/response, not a realtime channel. `not yet exercised`: reconnect
logic.

### Move 3 — the principle

**Request/response is the right default until perceived latency forces
streaming — and streaming is a cross-layer commitment, not a flag.** buffr
chose atomic, which is simpler at every layer (a `Promise<string>` end to
end). The cost is the opaque spinner on slow local generation. Switching
to streaming isn't a config change — it ripples through aptkit's provider,
the agent's return type, the session API, and the render loop. Knowing
that ripple is knowing why "just stream it" is a real piece of work, not a
toggle.

## Primary diagram

The atomic flow in full, with the streaming counterfactual marked.

```
  Realtime transports — buffr's atomic path (streaming absent)

  ┌─ UI: chat.tsx ───────────────────────────────────────────┐
  │  onSubmit → busy=true → <Spinner/> thinking…  (:13,48)   │
  │  answer = await session.ask(q)            (:28)          │
  │  setTurns([...t, { text: answer }])  ← ONE setState (:29)│
  └─────────────────────────────┬─────────────────────────────┘
                                │ Promise<string> (atomic)
  ┌─ session.ts ────────────────▼────────────────────────────┐
  │  agent.answer(question) → resolves once, complete  (:62) │
  └─────────────────────────────┬─────────────────────────────┘
                                │ one HTTP req/resp (file 05)
  ┌─ Ollama ─────────────────────▼───────────────────────────┐
  │  full generation (could stream NDJSON; buffr awaits one)  │
  └──────────────────────────────────────────────────────────┘

  ABSENT: WebSocket · SSE · token streaming consumed by buffr ·
          reconnect/backoff  →  all `not yet exercised`
```

## Elaborate

Streaming is the one absence here with a clear upgrade path and a clear
owner problem. The UX win (tokens appearing live) is real and well-known —
it's why AdvntrCue in `me.md` streams its GPT-4 responses. buffr doesn't,
and the blocker is the seam: the streaming capability would have to come
from aptkit's model provider, which buffr consumes rather than edits. So
this isn't "buffr forgot to stream" — it's "buffr's answer type is
`Promise<string>` because that's what its provider hands back, and changing
it is an aptkit-side commitment." That's the honest framing: a deliberate
atomic design, gated on an upstream change.

## Interview defense

**Q: "Does the chat stream tokens? Why or why not?"**

> No. `agent.answer()` resolves to one complete string (`session.ts:62`),
> `session.ask` is typed `Promise<string>`, and `chat.tsx` does a single
> setState with the full answer — there's no async iterator or partial
> append anywhere. The cost is an opaque spinner while a local 9B model
> generates, then the whole answer at once. Streaming would need a
> streaming provider from aptkit, a yielding agent return type, and a
> per-chunk render loop — and aptkit is consumed, not edited here, so it's
> an upstream change, not a buffr toggle.

```
  Promise<string> end-to-end → atomic
  spinner (opaque) → then full answer (one setState, chat.tsx:29)
  streaming = aptkit provider + agent iterator + render loop change
```

Anchor: *"`session.ts:30` types `ask(): Promise<string>` — atomic by
return type, top to bottom."*

**Q: "Any WebSockets or SSE?"**

> None, and structurally none possible in this shape: both need a server
> holding a connection open to push, and buffr has no inbound server and no
> browser. The UI updates via local React state, not pushed network events.

Anchor: *"No inbound server (file `01`) ⇒ no push transport ⇒ WS/SSE are
`not yet exercised`."*

## See also

- `05-http-semantics-caching-and-cors.md` — the single request/response
  exchange that streaming would replace.
- `01-network-map.md` — the absent inbound server that rules out WS/SSE.
- `07-timeouts-retries-pooling-and-backpressure.md` — the spinner has no
  timeout, so a hung generation spins forever.
- `study-system-design` — where a streaming boundary would sit.
