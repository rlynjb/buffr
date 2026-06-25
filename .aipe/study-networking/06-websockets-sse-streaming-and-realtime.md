# WebSockets, SSE, Streaming & Realtime

**Long-lived connections & token streaming** · Industry standard

## Zoom out, then zoom in

Verdict first: **buffr exercises none of this.** No WebSocket, no Server-Sent
Events, no token streaming. Every network call is request/response — fire,
block, get the whole answer, move on. That's a real and *defensible* choice for
a single-user CLI, and the most useful thing this file does is show you exactly
where streaming *would* slot in (aptkit even ships the machinery) and why buffr
doesn't reach for it.

```
  Zoom out — realtime's place (empty in buffr)

  ┌─ Provider layer ────────────────────────────────────────────────┐
  │   Ollama :11434 — CAN stream tokens, but buffr asks for one shot │
  └──────┬───────────────────────────────────────────────────────────┘
         │ HTTP request/response (NOT a stream)
  ┌─ Realtime transport ────────────────────────────────────────────┐
  │   ★ NOT YET EXERCISED ★                                          │ ★ THIS FILE ★
  │   no WebSocket · no SSE · no chunked token stream                │
  └──────┬───────────────────────────────────────────────────────────┘
         │
  ┌─ Service layer ─────────────────────────────────────────────────┐
  │   agent.answer(question) → awaits ONE complete string           │
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in: realtime transports answer "*how do I get data as it's produced
instead of waiting for all of it?*" buffr's answer is: it doesn't — it waits.
For a terminal that prints one final answer, that's fine. This file teaches the
pattern so you recognize the seam where it'd plug in.

## Structure pass

**Layers.** Ollama (can stream) → transport (one-shot) → agent (awaits whole) →
CLI (prints once). Trace *lifecycle* — when do bytes arrive — down.

**Axis — "when do the response bytes arrive?"**

```
  One question down the response stack

  "when do bytes arrive?"

  ┌─ Ollama ────────────────────────┐  → COULD emit token-by-token
  │  generation is incremental       │     (stream:true in /api/chat)
  └──────────────────────────────────┘
      ┌─ aptkit transport ──────────┐  → asks for the WHOLE response,
      │  fetch → await res.json()    │     awaits the full body
      └──────────────────────────────┘
          ┌─ agent.answer() ────────┐  → returns one complete string
          └──────────────────────────┘
              ┌─ CLI ───────────────┐  → prints once, at the end
              └──────────────────────┘

  the answer is "all at once, at the end" at every layer below Ollama.
  the streaming seam is the transport — and it's closed.
```

**Seam.** The seam where streaming would live is the transport's `await
res.json()`. Today it collects the full body before returning. To stream, that
single await becomes a loop over a chunked body — and the change ripples up
through `agent.answer()` (return type goes from `string` to an async iterable)
to the CLI (print incrementally). The seam is identifiable; it's just not open.

## How it works

### Move 1 — the mental model

Streaming flips the response from "one big value you await" to "a sequence you
consume as it lands" — the difference between `await fetch().then(r => r.json())`
and `for await (const chunk of stream)`. You've seen the second shape in any
typewriter-effect chat UI.

```
  Request/response  vs  streaming — the shape difference

  REQUEST/RESPONSE (buffr today)        STREAMING (not exercised)
  send ──►                              send ──►
         ⌛ block on whole body                ◄── token
  ◄── [entire answer]                         ◄── token
  print once                                  ◄── token  (print each)
                                              ◄── [done]

  same request; the response is one value vs a sequence over time
```

### Move 2 — the three realtime transports (and why none fit here)

**Streaming HTTP (chunked / NDJSON) — the one buffr is closest to.** Ollama's
`/api/chat` supports `stream: true`, emitting newline-delimited JSON, one token
chunk per line. The client reads the response body as a stream instead of
awaiting `.json()`. aptkit *ships* an ndjson stream reader — but buffr's path
(`RagQueryAgent.answer()`) uses the non-streaming transport that awaits the
whole body. So the capability exists one dependency away and buffr declines it.

```
  Layers-and-hops — where streaming WOULD plug in

  ┌─ Ollama ─────┐  NDJSON line per token   ┌─ transport ──┐
  │ stream:true  │ ───────────────────────► │ for await    │  (this loop
  │              │  {token}\n{token}\n...    │ over body     │   doesn't run
  └──────────────┘                           └──────┬───────┘   in buffr)
                                            instead buffr does:
                                            await res.json()  ← one shot
```

**Server-Sent Events (SSE) — a server→client one-way stream over HTTP.** Used
when a server pushes updates to a browser (`text/event-stream`, auto-reconnect
built in). buffr has no browser and no server, so SSE has no place. Not yet
exercised.

**WebSockets — full-duplex, both directions, one long-lived connection.** Used
for chat apps, live cursors, multiplayer. buffr's interactions are strictly
request→response with a clear end; there's no need for a persistent bidirectional
channel. Not yet exercised.

**The load-bearing absence: no reconnect logic.** Every realtime transport's
hard part is reconnection — what happens when the long-lived connection drops
mid-stream. buffr has *zero* of this because it has no long-lived connection;
each `fetch` is a complete, short request. That's the upside of request/response:
there's no stream to lose, so there's no reconnect to get wrong.

### Move 2.5 — current vs future state

```
  Phase A (now): request/response       Phase B (if streaming added)
  ┌──────────────────────────────┐      ┌──────────────────────────────┐
  │ agent.answer(): string        │      │ agent.answer(): AsyncIterable │
  │ await res.json()              │      │ for await (chunk of body)     │
  │ CLI prints once at the end    │      │ CLI prints token-by-token     │
  │ no reconnect, no partial state│      │ must handle mid-stream drops  │
  └──────────────────────────────┘      └──────────────────────────────┘

  what DOESN'T have to change: the pg wire, the embed call, the retrieval.
  only the chat transport + answer() return type + CLI print loop move.
```

The honest take: for a CLI that prints one answer, streaming buys *perceived*
latency (tokens appear sooner) but nothing functional. It's a UX upgrade with a
real cost (reconnect handling, partial-output state). Declining it today is the
right call; the seam is documented so it's a small, contained change later.

### Move 3 — the principle

Realtime transports trade simplicity for immediacy. Request/response is the
simplest possible contract — one send, one receive, a clear end, nothing to
reconnect. You reach for streaming, SSE, or WebSockets only when *time-to-first-
byte* or *bidirectionality* is worth the reconnect-and-partial-state complexity
they impose. buffr's workload — index a corpus, ask a question, get an answer —
has no such requirement, so the simplest contract wins.

## Primary diagram

buffr's actual realtime posture: request/response everywhere, streaming seam
marked but closed.

```
  buffr realtime posture — what's exercised

  ┌─ buffr ──────┐  POST /api/chat (no stream)  ┌─ Ollama ─────┐
  │ agent.answer │ ───────────────────────────► │ generate ALL │
  │   awaits     │  ◄─── [entire answer] ─────── │ then respond │
  └──────┬───────┘                               └──────────────┘
         │ return once
         ▼
   Ink renders the turn (session.ask → chat.tsx:28-29)

  ✗ no WebSocket   ✗ no SSE   ✗ no token stream   ✗ no reconnect
  seam for streaming = the await in aptkit's transport (closed)
  NB: chat IS long-lived — but in-process (one session), not a streamed socket
```

## Implementation in codebase

**Use cases.** None — this is the empty-set file. The closest thing is the
single blocking await in `session.ask()` that waits for the whole answer, which
the Ink UI then renders as one turn. Note the *session* is long-lived (one pg
pool, one conversation held across turns) but nothing on the *wire* is — each
`fetch` is still a short request/response.

**Code side by side.** The non-streaming shape is right here:

```
  src/session.ts  (lines 62-63)  +  src/cli/chat.tsx  (lines 28-29)

  const answer = await agent.answer(question);   ← ONE await, whole answer
  await trace.flush();                            ← (session.ts)
  ...
  const answer = await session.ask(q);            ← (chat.tsx) one string back
  setTurns((t) => [...t, { role: 'buffr', text: answer }]);  ← rendered once
            │
            └─ `answer` is a complete string. there is no chunk loop, no
               for-await, no partial output. if buffr streamed, ask() would
               return an iterable and chat.tsx would append tokens as they land.
```

For contrast, aptkit *has* the streaming primitive buffr doesn't call (shown to
prove the capability exists one layer away — not buffr's code):

```
  @rlynjb/aptkit-core .../runtime/ndjson-stream  (exists, unused by buffr)

  // a for-await NDJSON reader with signal support — the machinery for
  // token streaming is in the dependency; buffr's answer() path doesn't
  // use it, so no streaming reaches buffr.
```

## Elaborate

The three realtime transports map to three needs: chunked/NDJSON for *progressive
single responses* (LLM tokens), SSE for *server-push notifications* to browsers,
WebSockets for *bidirectional* live interaction. They share one hard problem —
connection liveness and reconnection — which is precisely the complexity
request/response avoids by being stateless and short. buffr lives in the
request/response world deliberately; the agent-loop's multi-turn behavior
(`study-agent-architecture`) happens *within* blocking calls, not across a
persistent stream.

## Interview defense

**Q: Does your agent stream tokens?**

```
  agent.answer() ─► await whole response ─► print once
  (Ollama could stream; buffr asks for one shot)
```

Answer: "No. `agent.answer()` awaits one complete string and the CLI prints it
once. Ollama supports `stream:true` and aptkit even ships an NDJSON reader, but
my path uses the non-streaming transport. For a CLI that emits one final answer,
streaming is a UX nicety that buys time-to-first-token at the cost of reconnect
and partial-state handling — not worth it here. And note `chat` being long-lived
doesn't change this: the session persists in-process, but each LLM call is still
a one-shot request/response." Anchor: `src/session.ts:62`, `src/cli/chat.tsx:28-29`.

**Q: What's the hardest part of streaming you avoided?**

Answer: "Reconnection. Every long-lived transport has to handle the connection
dropping mid-stream — resuming or restarting cleanly. Request/response has no
stream to lose, so there's no reconnect logic to get wrong. That's the main
thing buffr's simplicity buys."

## Validate

1. **Reconstruct:** the difference between awaiting one body and consuming a
   chunk sequence.
2. **Explain:** why is there no reconnect logic in buffr? (no long-lived
   connection; each `fetch` is short — `05`.)
3. **Apply:** you want token-by-token output. Name every layer that changes.
   (transport await→loop, `answer()` / `session.ask()` return type, Ink render
   loop — `src/session.ts:62`, `src/cli/chat.tsx:28-29`.)
4. **Defend:** justify request/response over streaming for this CLI. (single
   final answer; streaming adds reconnect/partial-state cost for UX-only gain.)

## See also

- `05-http-semantics-caching-and-cors.md` — the request/response calls this
  file says aren't streamed.

Updated: 2026-06-24 — Repointed the non-streaming-shape code off the deleted `ask-cmd.ts` onto `src/session.ts:62` + `src/cli/chat.tsx:28-29` (Ink renders the whole answer once). Added the key distinction: `chat` is now long-lived, but in-process (one session, one pool, one conversation) — NOT a streamed socket; every LLM `fetch` is still one-shot request/response, so this file stays the empty-set file.
- `07-timeouts-retries-pooling-and-backpressure.md` — the blocking await with no
  timeout is its own risk.
- `study-agent-architecture` — the multi-turn loop that runs inside blocking calls.
