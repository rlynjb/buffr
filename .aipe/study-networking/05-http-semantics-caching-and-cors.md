# 05 · HTTP Semantics, Caching, and CORS

> POST JSON to the local model server — Industry standard
> · the HTTP transport (`defaultHttpTransport`) lives in aptkit; buffr supplies the host

## Zoom out, then zoom in

buffr's only HTTP is two POSTs to Ollama: `/api/chat` for generation,
`/api/embed` for embeddings. And here's the key fact — **buffr doesn't write the
HTTP.** The `fetch()` calls live in aptkit's transport. buffr's entire HTTP
surface is the host string. CORS, cookies, caching, browser policy: all `not yet
exercised`, because there is no browser and no inbound server.

```
  Zoom out — HTTP lives one layer down, in aptkit

  ┌─ Process layer (buffr) ─────────────────────────────────────┐
  │  cfg.ollamaHost = "http://localhost:11434"  ── src/config.ts:14
  │       │ passed to providers                                  │
  │       ▼                                                       │
  │  GemmaModelProvider / OllamaEmbeddingProvider  (aptkit)      │
  │       │                                                       │
  │       ▼  ★ defaultHttpTransport — the only fetch() ★         │
  └───────┬──────────────────────────────────────────────────────┘
          │ HTTP/1.1  POST application/json
          ▼
   [ Ollama :11434 ]   /api/chat   /api/embed
```

Zoom in: HTTP semantics is the contract — method, headers, status, body. buffr
relies on a tiny slice of it (POST + JSON + a 2xx/non-2xx split) and ignores the
rest (no caching headers, no cookies, no conditional requests).

## Structure pass

**Layers.** buffr config → aptkit provider → aptkit transport (`fetch`) → Ollama.
The HTTP semantics live in the transport layer, which buffr injects a host into
but doesn't author.

**Axis — trace `who owns the HTTP contract?`**

```
  axis = "who decides method / headers / status handling?"

  ┌─ buffr ────────────────┐  seam  ┌─ aptkit transport ────────┐
  │ supplies host string   │ ══════►│ POST, content-type: json, │
  │ ONLY                   │ (flips)│ res.ok check, res.json()  │
  └────────────────────────┘        └────────────────────────────┘
   buffr owns 0% of HTTP            aptkit owns 100% of HTTP
```

**Seam.** The load-bearing seam is the provider boundary: buffr hands a host
string across it and gets back a typed result. Everything HTTP — the method, the
JSON serialization, the status check, the error message — is on aptkit's side.
That's a clean port/adapter split: buffr depends on the provider interface, not on
HTTP.

## How it works

### Move 1 — the mental model

You know how a `fetch(url, { method: 'POST', body })` either resolves with a
response you check `res.ok` on, or rejects on a network failure? That's the whole
shape. aptkit's transport is exactly that fetch, once for chat and once for embed.
buffr never sees it — it calls `agent.answer()` and a string comes back.

```
  Pattern — request/response over HTTP/1.1

   buffr: agent.answer(q)
       │
       ▼
   aptkit transport:
     POST /api/chat
     headers: { content-type: application/json }
     body:    { model, messages }
       │
       ▼ (TCP to :11434)
   Ollama
       │
       ▼
     200 + { message } ──► res.ok ? res.json() : throw
       │
       ▼
   string answer back to buffr
```

### Move 2 — the walkthrough

**buffr's contribution is one line.** The host string (`src/config.ts:14`):

```ts
ollamaHost: env.OLLAMA_HOST || 'http://localhost:11434',
```

passed into both providers (`src/session.ts:40,46`). That's it. buffr does not
construct a `Request`, set a header, or read a status code.

**The actual HTTP is aptkit's `defaultHttpTransport`.** Inside
`@aptkit/provider-gemma`, the chat transport is:

```js
function defaultHttpTransport(host) {
  const base = host.replace(/\/$/, '');                  // strip trailing slash
  return async ({ signal, ...payload }) => {
    const res = await fetch(`${base}/api/chat`, {        // ── POST to /api/chat
      method: 'POST',
      headers: { 'content-type': 'application/json' },   // ── JSON body
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {}),                     // ── optional AbortSignal
    });
    if (!res.ok) {                                       // ── status split: 2xx vs not
      throw new Error(`ollama HTTP ${res.status}: ${await res.text()}`);
    }
    return res.json();
  };
}
```

Read the HTTP semantics buffr actually depends on:

- **Method: POST.** Both endpoints are POST — they carry a request body (the
  prompt / the texts) and are not idempotent reads. No GET anywhere.
- **One header: `content-type: application/json`.** No auth header (it's
  loopback, no token), no `accept`, no cache-control, no cookies.
- **Status handling is a binary split.** `res.ok` (any 2xx) → parse JSON.
  Anything else → throw `ollama HTTP <status>: <body>`. There's no per-status
  logic (no 429 backoff, no 404 special-case) — every non-2xx is one error class.
  That's the *only* HTTP semantic buffr's failure path knows.
- **No retry on the status split.** A 503 from an overloaded Ollama throws
  immediately. → `07-timeouts-retries-pooling-and-backpressure.md`.

The embed transport (`@aptkit/retrieval`) is the same shape against `/api/embed`,
returning `json.embeddings`.

```
  Layers-and-hops — one chat completion over HTTP

  ┌─ buffr ───────────────┐
  │ agent.answer(q)       │
  └──────────┬────────────┘
             │ hop 1: provider builds { model, messages }
             ▼
  ┌─ aptkit transport ────┐
  │ fetch POST /api/chat  │
  └──────────┬────────────┘
             │ hop 2: HTTP/1.1 POST + JSON body   ──► ┌─ Ollama ─┐
             │ hop 3: 200 + { message } JSON      ◄── │ gemma2:9b│
             ▼                                         └──────────┘
  res.ok ? res.json() : throw  ──► string back to buffr
```

**CORS, cookies, caching — all absent, and correctly so.**

- **CORS is `not yet exercised`.** CORS is a *browser* enforcement — the browser
  refuses to let JS read a cross-origin response without the right
  `Access-Control-Allow-Origin` header. buffr is a Node process; `fetch` in Node
  doesn't enforce CORS. No browser, no CORS. It would only appear if buffr grew a
  browser frontend hitting a cross-origin API.
- **Cookies are `not yet exercised`.** No session cookie, no `Set-Cookie`
  handling. The Ollama calls are stateless POSTs; identity isn't carried in a
  cookie (there's no auth at all).
- **HTTP caching is `not yet exercised`.** No `Cache-Control`, no `ETag`, no
  conditional `If-None-Match`. Every embed and every chat is a fresh POST.
  Caching would matter if buffr re-embedded identical text often — it doesn't
  dedupe at the HTTP layer.

### Move 3 — the principle

buffr depends on the *thinnest possible slice* of HTTP — POST, JSON, ok/not-ok —
and pushes the actual protocol into a transport it can swap. That's the right
altitude for a client: depend on the provider contract, not on `fetch`. The cost
is that buffr's failure handling is coarse (one error class for every non-2xx),
which is the tradeoff `07` examines.

## Primary diagram

```
  buffr HTTP — recap

  buffr surface:  cfg.ollamaHost = "http://localhost:11434"  (src/config.ts:14)
                  passed to both providers — buffr writes NO fetch

  aptkit transport (defaultHttpTransport):
    POST /api/chat   { model, messages }  → { message }     (gemma2:9b)
    POST /api/embed  { model, input }      → { embeddings }  (nomic-embed)
    header:  content-type: application/json   (no auth, no cache, no cookie)
    status:  res.ok → json | else → throw `ollama HTTP <status>`

  CORS:    not yet exercised (no browser)
  cookies: not yet exercised (stateless, no auth)
  caching: not yet exercised (every call a fresh POST)
```

## Elaborate

The provider/transport split aptkit uses is the standard way to keep an LLM
client testable: inject a fake transport in tests, use the real `fetch` in prod
(the `OllamaEmbeddingProvider` docstring literally says "pass `embed` to feed
recorded vectors in tests"). HTTP semantics like caching and conditional requests
matter most for *read-heavy* APIs over the public internet; buffr's traffic is
write-shaped POSTs to a local server, so the slice it uses is genuinely all it
needs. The day buffr fronts a remote model API with rate limits, the `res.ok`
binary split is the first thing that needs to grow a 429 branch.

## Interview defense

**Q: What HTTP does buffr actually speak?**

```
  POST /api/chat  + POST /api/embed   — JSON bodies, ok/not-ok handling
  buffr writes none of it — it supplies a host string
```

Answer: "Two POSTs to Ollama — chat and embed — both JSON. But buffr doesn't
author the HTTP; the `fetch` lives in aptkit's `defaultHttpTransport`. buffr's
whole HTTP surface is the host string `http://localhost:11434` at
`src/config.ts:14`. It never sees a header or status code directly."

**Q: How does buffr handle a CORS error from the model server?**

Answer: "It can't get one — CORS is a browser enforcement and buffr is a Node
process. No browser in the loop means CORS never fires. It'd only appear if buffr
grew a browser frontend." That's the load-bearing distinction people miss: CORS is
browser policy, not a server-side or Node-`fetch` concern.

**Q: How are non-2xx responses handled?**

Answer: "Coarsely — one class. `res.ok` false throws `ollama HTTP <status>:
<body>`. No per-status logic, no 429 backoff. Every failure is the same error, and
it surfaces in the Ink catch (`src/cli/chat.tsx:30`) with no retry."

## See also

- `06-websockets-sse-streaming-and-realtime.md` — why the chat response isn't streamed
- `07-timeouts-retries-pooling-and-backpressure.md` — the missing 429/timeout/retry handling
- `04-tls-and-trust-establishment.md` — why this HTTP is plaintext (loopback)
- `study-security` — trusting the model server's responses; no auth header
