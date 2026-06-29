# 06 · WebSockets, SSE, Streaming, and Realtime

> Long-lived connections and token streaming — Industry standard
> · all `not yet exercised`; the model response is awaited whole (`agent.answer`)

## Zoom out, then zoom in

Verdict first: **none of this is in the repo.** No WebSocket, no Server-Sent
Events, no token-by-token streaming, no reconnect logic. The chat response comes
back as one complete string. This file's job is to show you *exactly where*
streaming would slot in, why it's absent, and what it would cost to add — because
"not yet exercised" is only useful if you can see the seam it would attach to.

```
  Zoom out — where streaming WOULD live (but doesn't)

  ┌─ UI layer (Ink TUI) ────────────────────────────────────────┐
  │  busy spinner ── then the WHOLE answer appears at once        │
  │       ▲                                                        │
  │       │ one string, after the full turn completes             │
  └───────┼──────────────────────────────────────────────────────┘
          │ ★ where SSE/streaming WOULD inject tokens ★
  ┌─ Service layer (session) ───────────────────────────────────┐
  │  const answer = await agent.answer(question)  ── awaited whole│
  └───────┬──────────────────────────────────────────────────────┘
          │ HTTP POST (request/response, not a stream)
          ▼
   [ Ollama ]   responds with a complete body
```

Zoom in: realtime transports keep a connection open so bytes flow *as they're
produced* — a token stream, a live feed. buffr instead uses a plain
request/response: ask, wait, get the whole answer. The realtime layer is empty.

## Structure pass

**Layers.** UI (Ink) → Session (`ask`) → Provider (HTTP). The realtime concern
would live at the seam between Session and Provider — does the answer arrive in
one piece or as a stream?

**Axis — trace `when does the UI see output?`**

```
  axis = "when do bytes reach the screen?"

  TODAY (request/response):
  ┌─ ask ──┐  full turn  ┌─ render ──┐
  │ await  │ ═══════════►│ whole text│   user waits, then sees ALL at once
  └────────┘             └───────────┘

  IF STREAMED (SSE/chunked):
  ┌─ ask ──┐  token  ┌─ render ──┐
  │ stream │ ═══════►│ token...   │   tokens appear as generated
  └────────┘  token  └───────────┘
```

**Seam.** The seam that *would* flip is `agent.answer()`. Today it returns
`Promise<string>` — a single resolved value. Streaming would change that contract
to an async iterator / callback, and the flip would ripple up into the Ink
component's render. Because the contract is "one string," nothing downstream is
built for incremental output.

## How it works

### Move 1 — the mental model

You know the difference between `await fetch().then(r => r.json())` (you get the
whole body, then act) versus reading a `ReadableStream` chunk by chunk (you act on
each piece as it lands)? buffr is firmly the first one. The model generates the
full completion, the transport reads the whole JSON body, and only then does buffr
have an answer.

```
  Pattern — request/response (what buffr does)

   ask ──► [ generate entire completion ] ──► whole body ──► string
            (user sees a spinner the whole time)

  Pattern — streaming (what buffr does NOT do)

   ask ──► tok─tok─tok─tok─tok ──► render each as it arrives
            (no waiting for the whole thing)
```

### Move 2 — the walkthrough

**The answer is awaited as a single value.** The one line that settles it
(`src/session.ts:62`):

```ts
const answer = await agent.answer(question);   // Promise<string> — resolves ONCE, whole
```

`agent.answer` returns `Promise<string>`. There's no `for await`, no stream
handler, no chunk callback. The turn blocks until the complete answer exists, then
returns it.

**The Ink UI renders the whole string in one `setState`.** The render side
matches (`src/cli/chat.tsx:28-29`):

```ts
const answer = await session.ask(q);
setTurns((t) => [...t, { role: 'buffr', text: answer }]);   // whole answer, one append
```

Between submit and this line, the UI shows a spinner (`busy` true, the `<Spinner
type="dots" /> thinking…` block at `src/cli/chat.tsx:48-52`). The user sees
*nothing* of the answer until it's fully done, then the whole block appears. A
streaming version would append tokens to the last turn as they arrived.

**The HTTP transport reads the whole body too.** Recall from `05` that
`defaultHttpTransport` does `res.json()` — it waits for the *complete* response
body and parses it as one JSON object. Ollama's `/api/chat` supports a streaming
mode (NDJSON chunks), but aptkit's default transport doesn't request or consume
it. So the absence of streaming is consistent all the way down: whole body at the
transport, whole string at the session, whole block at the UI.

```
  Layers-and-hops — the whole-answer path (no stream anywhere)

  ┌─ Ink TUI ─────────────┐
  │ spinner while busy     │  ◄── nothing rendered until done
  └──────────┬─────────────┘
             │ hop 1: session.ask(q)  → awaits whole string
             ▼
  ┌─ session ─────────────┐
  │ await agent.answer(q)  │  ◄── Promise<string>, resolves once
  └──────────┬─────────────┘
             │ hop 2: HTTP POST /api/chat
             ▼
  ┌─ aptkit transport ────┐
  │ res.json() — whole body│  ◄── not NDJSON streaming
  └────────────────────────┘
```

**WebSocket and SSE: `not yet exercised`, and there's no place for them.** Both
are server-push transports — they need a *server* holding a long-lived connection
to push to a client. buffr has no inbound server and no browser client, so neither
transport has a home here. They'd become relevant only if buffr grew a UI that
needed live updates pushed *to* it (a web dashboard, a multi-client view) — which
is a different architecture, not a tweak.

**Reconnect logic: `not yet exercised`.** No long-lived connection means nothing
to reconnect. The only persistent connections are the pooled pg sockets, and the
pool (with default settings) handles socket health itself — buffr writes no
reconnect loop.

### Move 2.5 — current vs future

Phase A (now): whole-answer request/response. Simple, correct, and the user stares
at a spinner for the full generation time.

Phase B (if streaming is added): the cost is a contract change at `agent.answer`
— it'd have to yield tokens (async iterator or callback), the transport would
switch to consuming Ollama's NDJSON stream, and the Ink component would append to
the in-flight turn. What *doesn't* change: the pg-wire path, the trace flush, the
memory write — all of those still happen after the stream completes. Streaming is
a UX change on the model path only. It's an aptkit-side change first (the transport
and `answer` signature live there), exactly like the "sequential in-prompt turn
history" gap the session docstring names at `src/session.ts:25-27`.

### Move 3 — the principle

Streaming is a latency-*perception* optimization, not a throughput one — the total
generation time is the same, but the user sees first-token-fast instead of
all-or-nothing. For a local single-user CLI where the model runs on the same box,
the whole-answer approach is a legitimate call: simpler contract, no partial-render
complexity, and the latency is yours to feel, not a customer's. The seam to grow
it is `agent.answer`'s return type — and it's an aptkit change before it's a buffr
one.

## Primary diagram

```
  buffr realtime — recap (everything here is absent)

  streaming:    NOT exercised — agent.answer() returns Promise<string>
                whole answer, one setState  (src/session.ts:62, chat.tsx:29)
  transport:    res.json() reads the WHOLE body (no NDJSON stream consumed)
  WebSocket:    NOT exercised — no inbound server, no browser client
  SSE:          NOT exercised — same reason (server-push needs a server)
  reconnect:    NOT exercised — no long-lived app connection to recover

  the only persistent sockets are the pg pool (managed by node-postgres)
```

## Elaborate

SSE and WebSocket solve "the server has new data and wants to push it to a client
without the client polling" — chat token streams, live notifications, collaborative
cursors. They presuppose a server and (usually) a browser. buffr is a client-only
CLI, so the realtime layer is structurally empty, not merely unimplemented. Token
streaming is the one realtime feature that *would* fit (it's a client consuming a
stream, no inbound server needed) — and the place it attaches is crisp:
`agent.answer`'s signature and the transport's `res.json()`. That's the value of
naming an absence precisely: you know the exact two lines that change.

## Interview defense

**Q: Does the chat stream tokens?**

```
  await agent.answer(q) → Promise<string> → one setState
  spinner until done, then the whole answer appears
```

Answer: "No. `agent.answer()` returns `Promise<string>` (`src/session.ts:62`) —
the whole answer, awaited once, rendered in a single Ink update
(`src/cli/chat.tsx:29`). The transport reads the complete body with `res.json()`,
not Ollama's NDJSON stream. The user sees a spinner, then everything at once."

**Q: How would you add streaming?**

Answer: "Change `agent.answer`'s contract to yield tokens — an async iterator or a
callback — switch the transport to consume Ollama's streaming NDJSON, and have the
Ink component append to the in-flight turn instead of waiting. It's an aptkit-side
change first, since the transport and the `answer` signature live there. The
pg-wire writes stay after the stream completes — streaming only touches the model
path."

**Q: Why no WebSocket or SSE?**

Answer: "Both are server-push transports — they need a server holding a connection
to push to a client. buffr has no inbound server and no browser, so there's no home
for them. They'd only appear with a different architecture, like a web dashboard."

## See also

- `05-http-semantics-caching-and-cors.md` — the request/response the stream would replace
- `03-tcp-udp-connections-and-sockets.md` — the pg pool, the only persistent sockets
- `07-timeouts-retries-pooling-and-backpressure.md` — what a long generation does with no timeout
