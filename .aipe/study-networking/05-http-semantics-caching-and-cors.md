# HTTP Semantics, Caching, and CORS

**Industry name(s):** HTTP request/response semantics / browser security
policy (CORS) / HTTP caching. **Type:** Industry standard.

## Zoom out, then zoom in

buffr speaks HTTP in exactly one direction: *outbound* to Ollama. And it
barely speaks it — buffr's entire HTTP surface is the host *string*
`http://localhost:11434`. The actual methods, headers, bodies, and status
handling live inside aptkit's providers. So this file is half "what HTTP
buffr triggers" and half "the large HTTP topics this repo never touches" —
CORS, caching, cookies — all `not yet exercised`, and for a clean reason.

```
  Zoom out — buffr's HTTP surface is one string

  ┌─ Config (buffr) ─────────────────────────────────────────┐
  │  ollamaHost = "http://localhost:11434"   (config.ts:14)  │ ← ★ the
  │  ── that's the ENTIRE HTTP surface buffr owns ──         │   whole
  └─────────────────────────────┬─────────────────────────────┘   surface
                                │  host string
  ┌─ Transport (aptkit) ────────▼────────────────────────────┐
  │  OllamaEmbeddingProvider / GemmaModelProvider            │
  │   build the request: method, path, headers, JSON body    │
  │   call fetch(), parse status + response                  │
  └─────────────────────────────┬─────────────────────────────┘
                                ▼ HTTP POST, TCP 11434
  ┌─ Ollama daemon ──────────────────────────────────────────┐
  │  /api/embeddings · /api/generate                         │
  └──────────────────────────────────────────────────────────┘
```

Zoom in. The concept is **HTTP semantics**: methods (GET/POST), status
codes, headers, and the request/response shape. The seam that defines this
file: buffr provides the *address*; aptkit owns the *protocol*. buffr never
constructs an HTTP request itself.

## Structure pass

**Layers.** Config (the host string) → aptkit provider (builds + sends the
HTTP request) → Ollama (responds).

**Axis — control / "who decides the HTTP request's shape?"** This axis is
the whole story of this file:

```
  axis: "who builds the HTTP request?"

  ┌─ buffr config.ts ──────────┐  → only the HOST. nothing else.
  └────────────────────────────┘
  ┌─ aptkit provider ──────────┐  → method, path, headers, body,
  │                            │     status handling — ALL of it
  └────────────────────────────┘
  ┌─ Ollama ───────────────────┐  → the response semantics
  └────────────────────────────┘

  control over HTTP flips entirely to aptkit at the very first seam
```

**Seam.** The seam is the `host: cfg.ollamaHost` argument at
`session.ts:40` and `:46`. On buffr's side: a string. On aptkit's side: a
full HTTP client. Control over every HTTP semantic flips across that one
argument — which is why buffr's HTTP code is, almost literally, one line.

## How it works

### Move 1 — the mental model

Think of how you use a typed API client in a frontend: you call
`api.getUser(id)` and never see the `GET /users/:id`, the headers, or the
status check — the client owns all of it; you own the *base URL* you
configured it with. buffr relates to aptkit's Ollama providers exactly
that way. buffr configures the base host; aptkit is the client.

```
  The control split — address vs protocol

   buffr ─────────► "http://localhost:11434"
                          │ (just the origin)
                          ▼
   aptkit provider ──► POST /api/generate
                       Content-Type: application/json
                       body: { model, prompt, ... }
                       ──► fetch() ──► read status + JSON
```

### Move 2 — walk the HTTP surface

**buffr's contribution: the origin, twice.** `src/session.ts:40` and
`:46`:

```
  session.ts:40,46 — the only HTTP buffr "writes"

  new OllamaEmbeddingProvider({ model: 'nomic-embed-text:v1.5',
                                host: cfg.ollamaHost });   // :40
  new GemmaModelProvider({ host: cfg.ollamaHost });        // :46
  //                              └──────┬──────┘
  //          a host string. no path, no method, no headers,
  //          no fetch — buffr stops at the origin.
```

The same `cfg.ollamaHost` flows into `index-cmd.ts:18` and `eval-cmd.ts:14`
for the embed-only paths. Everywhere, buffr's HTTP involvement ends at the
host string.

**The actual request lives in aptkit.** When `agent.answer()` runs
(`session.ts:62`), aptkit's `GemmaModelProvider` issues an HTTP POST to
Ollama's generate endpoint; when the retrieval pipeline embeds a query,
`OllamaEmbeddingProvider` POSTs to the embeddings endpoint. Method, path,
`Content-Type`, the JSON body, and reading the status code are all
aptkit's. Since `me.md` marks aptkit as *consumed, never edited here*, the
honest statement is: **buffr triggers these HTTP requests but does not
define their semantics.** Treat the exact headers/paths as aptkit's
contract, not buffr's code.

```
  Request flow — buffr triggers, aptkit shapes, Ollama answers

  ┌─ buffr ──────┐ host    ┌─ aptkit provider ─┐  HTTP POST  ┌─ Ollama ┐
  │ session.ask  │ ──────► │ build req + body  │ ──────────► │ generate│
  │ → agent      │         │ fetch()           │            │ /embed  │
  │   .answer()  │ ◄────── │ parse status+json │ ◄────────── │ 200+JSON│
  └──────────────┘ string  └───────────────────┘  response  └─────────┘
       ▲
       │ if aptkit throws (non-2xx, parse fail), it bubbles to
       │ chat.tsx:30's try/catch → rendered as "error: ..."
```

**Status codes and errors: surfaced, not handled.** buffr does no HTTP
status inspection of its own. If Ollama returns a non-2xx, or the body
fails to parse, aptkit throws, and that error propagates up through
`agent.answer()` to the per-turn `try/catch` at `src/cli/chat.tsx:30`,
which renders `error: <message>`. So buffr's HTTP error handling is
exactly one catch clause: show the message, keep the session alive, let
the user retry by typing again. There is no status-code-specific logic (no
"retry on 503", no "re-auth on 401") — file `07` covers that absence.

**CORS: not applicable, by construction.** CORS is a *browser*
same-origin policy enforced on *inbound* cross-origin requests. buffr is a
Node process making *outbound* requests, and it accepts no inbound HTTP at
all (file `01`: nothing listens). There is no browser and no server, so
CORS has nothing to apply to. `not yet exercised` — and it never will be
in this shape.

```
  why CORS is absent — the policy has nothing to govern

  CORS governs:  browser ──► cross-origin SERVER (inbound, browser-enforced)
  buffr is:      node ──► Ollama / Postgres (outbound, no browser)

  no browser + no inbound server = CORS is structurally irrelevant
```

**Cookies, sessions, auth headers: none in buffr.** No `Set-Cookie`, no
bearer tokens, no session middleware. The local Ollama daemon needs no
auth. The "session" in buffr is a *conversation* held in process memory
(`session.ts`), not an HTTP cookie session — same word, unrelated concept.
`not yet exercised`: HTTP-level auth.

**HTTP caching: none.** No `Cache-Control`, no `ETag`, no conditional
requests, no response cache. Every turn re-embeds and re-generates from
scratch against Ollama. There's a caching-shaped thing in the system —
retrieval and conversation memory both pull from Postgres — but that's
*application*-level reuse of stored vectors, not HTTP caching, and it lives
behind boundary 1 (pg), not boundary 2 (HTTP). `not yet exercised`:
HTTP-layer caching.

### Move 3 — the principle

**Own the address, delegate the protocol, and your HTTP code shrinks to a
config line.** By keeping only the host string and letting aptkit own
method/headers/body/status, buffr's HTTP surface is impossible to get
subtly wrong — there's almost nothing there to get wrong. The cost is that
buffr can't add HTTP-level behavior (a timeout, a retry on 503, a cache)
without reaching into aptkit, which it won't. That tradeoff is why file
`07`'s absences are absences: the place to add them isn't in buffr.

## Primary diagram

The whole HTTP picture, including what's absent.

```
  HTTP semantics — present (outbound) and absent (the rest)

  ┌─ buffr ──────────────────────────────────────────────────┐
  │  HTTP surface = "http://localhost:11434"  (config.ts:14) │
  └───────┬───────────────────────────────────────────────────┘
          │ host string only
  ┌───────▼─── aptkit (owns the protocol) ───────────────────┐
  │  POST /api/generate · /api/embeddings                    │
  │  Content-Type: application/json · JSON body · status     │
  │  non-2xx / parse-fail → throw → chat.tsx:30 try/catch    │
  └───────┬───────────────────────────────────────────────────┘
          ▼ TCP 11434
       Ollama

  not yet exercised:  CORS · cookies · auth headers ·
                      HTTP caching · inbound HTTP server
```

## Elaborate

The cleanest way to hold this file: buffr is an HTTP *client of one
endpoint family*, and even that it delegates. Compare AdvntrCue from
`me.md` — a Next.js app that *serves* HTTP, sets streaming responses,
handles its own routes, and lives inside the browser security model (CORS,
cookies all in play). buffr is the photographic negative: outbound-only,
no server, no browser, HTTP delegated to a library. Recognizing which of
the two shapes you're in tells you instantly which HTTP topics are even
relevant — and for buffr, most of them aren't.

## Interview defense

**Q: "How does this app handle HTTP? CORS? Caching?"**

> buffr's only HTTP is outbound to Ollama, and its whole surface is the
> host string `http://localhost:11434` in `config.ts:14`. aptkit's
> providers own the actual method, path, headers, body, and status — buffr
> just supplies the origin. CORS is structurally absent: it's a browser
> inbound-policy and buffr is a Node process with no browser and no server.
> No HTTP caching either — every turn re-embeds and re-generates; the only
> reuse is application-level vectors in Postgres, which isn't HTTP caching.

```
  buffr → host string only · aptkit → full HTTP client
  CORS: no browser + no inbound server = N/A
  caching: app-level (pg vectors), not HTTP
```

Anchor: *"`session.ts:40,46` pass `host: cfg.ollamaHost` and nothing else
— aptkit owns the request."*

**Q: "What happens when Ollama returns an error?"**

> aptkit throws on non-2xx or a parse failure; the error bubbles through
> `agent.answer()` to the per-turn try/catch at `chat.tsx:30`, which
> renders `error: <message>` and keeps the session alive. There's no
> status-specific handling — no retry on 503, no re-auth on 401. The user
> just retries by typing again.

Anchor: *"`chat.tsx:30` — one catch clause is buffr's entire HTTP error
policy."*

## See also

- `01-network-map.md` — boundary 2 (the Ollama HTTP hop) and the absent
  inbound boundary.
- `02-dns-routing-and-addressing.md` — the `localhost` origin the HTTP
  request targets.
- `06-websockets-sse-streaming-and-realtime.md` — why the Ollama response
  arrives as one string, not a stream.
- `07-timeouts-retries-pooling-and-backpressure.md` — the missing
  status-code retries and request timeouts.
- `study-security` — auth posture on these endpoints.
