# HTTP Semantics, Caching & CORS

**Request/response to a local model server** · Industry standard

## Zoom out, then zoom in

buffr's only HTTP is two outbound POSTs to Ollama — and buffr doesn't even write
the `fetch`. It hands aptkit a host string, and aptkit's transport posts to
`/api/chat` and `/api/embed`. There's no inbound HTTP server, so the entire
browser half of "HTTP semantics" — CORS, cookies, caching headers, preflight —
is **not yet exercised**. This file walks the small HTTP surface that *is* real
and is honest about the large surface that isn't.

```
  Zoom out — buffr's HTTP surface

  ┌─ Provider layer ────────────────────────────────────────────────┐
  │   Ollama HTTP server :11434  (POST /api/chat, POST /api/embed)   │
  └──────┬───────────────────────────────────────────────────────────┘
         │ HTTP/1.1 request/response (JSON body)
  ┌─ Network boundary ──────────────────────────────────────────────┐
  │   aptkit defaultHttpTransport — fetch() lives HERE, not in buffr │ ★ THIS FILE ★
  └──────┬───────────────────────────────────────────────────────────┘
         │ host string only
  ┌─ Service layer (buffr) ─────────────────────────────────────────┐
  │   OllamaEmbeddingProvider / GemmaModelProvider({ host })         │
  └──────────────────────────────────────────────────────────────────┘

  NOT present: any HTTP server, any browser client, CORS, cookies, cache.
```

Zoom in: HTTP semantics answer "*what does this request mean and what does the
status code promise?*" For buffr the answer is two POSTs with JSON bodies and a
binary `ok`/throw on the response. No idempotency concerns, no caching, no
cross-origin — because there's no browser and no GET.

## Structure pass

**Layers.** buffr config → aptkit transport → HTTP message → Ollama. Trace
*control* — who decides the request shape — down.

**Axis — "who decides the HTTP request?"**

```
  One question down the HTTP stack

  "who controls this request?"

  ┌─ buffr (ask-cmd.ts) ────────────────────┐  → decides the HOST only
  │  new GemmaModelProvider({ host })        │     ("which server?")
  └──────────────────────────────────────────┘
      ┌─ aptkit transport ──────────────────┐  → decides method, path,
      │  fetch(`${host}/api/chat`, {POST})   │     headers, body shape
      └──────────────────────────────────────┘
          ┌─ Ollama ────────────────────────┐  → decides status + response
          │  200 + JSON  /  4xx-5xx + text   │     body
          └──────────────────────────────────┘

  control flips at the buffr↔aptkit seam: buffr picks the door,
  aptkit decides what to say through it
```

**Seam.** Same seam as the network map: `host: cfg.ollamaHost`. The HTTP method,
path, headers, and body all live on aptkit's side of it. If you wanted to add a
header (say, an auth token for a remote Ollama), you couldn't from buffr — the
seam only carries a host. That's a real constraint worth knowing.

## How it works

### Move 1 — the mental model

An HTTP request is a method + path + headers + body, and the response is a
status code + headers + body. You build these every time you call `fetch` in a
frontend. Here it's the same shape, just server-to-server and always POST with
a JSON body.

```
  The HTTP request/response kernel

  REQUEST                          RESPONSE
  POST /api/chat        ──────►    200 OK
  content-type: json               (or 4xx/5xx)
  { model, messages }   ◄──────    { message: {...} }

  status code is the contract: 2xx = body is the answer,
  non-2xx = body is an error string. that branch is the whole protocol.
```

### Move 2 — the two requests, step by step

**The embed request.** `OllamaEmbeddingProvider.embed(texts)` → aptkit posts
`POST /api/embed` with body `{ model, input: texts }`. On `res.ok` it returns
`json.embeddings`; otherwise it throws `ollama HTTP ${status}: ${body}`.

```
  Layers-and-hops — embed request

  ┌─ buffr ────────┐ embed(texts)  ┌─ aptkit transport ─┐  POST /api/embed
  │ pipeline.index │ ─────────────►│ fetch(host+/embed) │ ──────────────────►
  └────────────────┘               └─────────┬──────────┘     Ollama :11434
                                    res.ok?   │
                              ┌───────────────┴──────────────┐
                          true: return json.embeddings   false: throw
                              (768-dim vectors)           "ollama HTTP 4xx/5xx"
```

**The chat request.** `GemmaModelProvider.chat(messages)` → `POST /api/chat`
with the full payload, returns the parsed JSON on `res.ok`, throws on non-ok.
Same status-branch shape.

**The status-code branch is the entire error protocol.** aptkit checks one
thing: `res.ok` (status 200–299). Anything else becomes a thrown `Error` whose
message includes the status and the response text. There's no per-status
handling — a 404 (wrong path), a 500 (model crashed), and a 503 (model loading)
all collapse into the same throw. For buffr's purposes that's adequate: the CLI
just surfaces the error and exits.

```
  State — how a response is interpreted

  ┌─ 2xx ─┐   parse JSON body ──► return result   (the happy path)
  ┌─ 4xx ─┐ ┐
  ┌─ 5xx ─┐ ┴─► throw Error("ollama HTTP <status>: <text>")  (one bucket)

  no retry, no per-status logic — covered in 07
```

**Caching: none, and that's correct.** Every request is a POST with a unique
body (a unique question or unique texts). POSTs aren't cacheable by default, and
even if they were, an LLM completion for a novel prompt has no cache value. The
embed call *could* be cached (same text → same vector), but neither buffr nor
aptkit does — every index/query re-embeds. That's a `study-performance-
engineering` observation, not a correctness one.

### Move 2.5 — what's NOT exercised (the browser half)

This is the honest core of the file. Everything below is real HTTP machinery
that buffr does not touch, because buffr runs no server and serves no browser:

```
  HTTP surface — exercised vs not

  EXERCISED                        NOT YET EXERCISED
  ┌──────────────────────────┐    ┌──────────────────────────────┐
  │ outbound POST /api/chat   │    │ inbound HTTP server (none)    │
  │ outbound POST /api/embed  │    │ GET / idempotency / methods   │
  │ res.ok status branch      │    │ CORS / preflight / origins    │
  │ content-type: json header │    │ cookies / Set-Cookie / auth   │
  │                           │    │ Cache-Control / ETag / 304    │
  │                           │    │ redirects (3xx)               │
  └──────────────────────────┘    └──────────────────────────────┘

  the right column becomes relevant only if buffr grows an inbound server
  (a different deployment phase — see context.md "no Edge Functions")
```

CORS specifically: CORS is a *browser* policy enforced on cross-origin requests
from page JavaScript. buffr's HTTP calls originate from a Node process, not a
browser — the same-origin policy doesn't apply to Node `fetch` at all. So CORS
isn't "missing," it's *categorically irrelevant* to a CLI. It would only appear
if buffr served a web UI.

### Move 3 — the principle

HTTP is a request/response contract where the status code is the promise. Most
of HTTP's apparatus — caching, CORS, cookies, conditional requests — exists to
serve *browsers* talking to *servers*. A server-to-server JSON client like
buffr uses a thin slice: POST, a JSON body, and a 2xx check. Knowing which slice
you're in stops you from worrying about CORS in a CLI or forgetting cache
headers in a public API.

## Primary diagram

The full HTTP surface — both POSTs, the status branch, the absent server.

```
  buffr ⇄ Ollama over HTTP — the complete picture

  ┌─ buffr (Node, no server) ───────────────────────────────────────┐
  │  GemmaModelProvider({host})      OllamaEmbeddingProvider({host}) │
  └───────┬───────────────────────────────────┬─────────────────────┘
          │ (aptkit transport owns fetch)      │
   POST /api/chat                       POST /api/embed
   {model, messages}                    {model, input}
          ▼                                    ▼
  ┌─ Ollama :11434 ─────────────────────────────────────────────────┐
  │  200 → JSON body          non-2xx → throw "ollama HTTP <status>" │
  └──────────────────────────────────────────────────────────────────┘

  no inbound arrows. no GET. no CORS. no cookies. no cache.
```

## Implementation in codebase

**Use cases.** The chat POST fires once per `ask` (hop 5). The embed POST fires
once per indexed document (`index`) and once per query (`ask`, `eval`). buffr
configures both by host string and never touches the request itself.

**Code side by side.** buffr's entire HTTP contribution:

```
  src/cli/ask-cmd.ts  (lines 20, 26)

  const embedder = new OllamaEmbeddingProvider(
    { model: 'nomic-embed-text:v1.5', host: cfg.ollamaHost });  ← embed endpoint
  ...
  const model = new ContextWindowGuardedProvider(
    new GemmaModelProvider({ host: cfg.ollamaHost }), ...);     ← chat endpoint
            │
            └─ buffr supplies HOST and MODEL. method/path/headers/body are
               aptkit's. this is the whole HTTP-config surface of the repo.
```

The actual request shape lives in aptkit (shown for context — *not* buffr's
code, this is the dependency):

```
  @rlynjb/aptkit-core .../provider-gemma defaultHttpTransport

  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },   ← the one header
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`ollama HTTP ${res.status}: ${await res.text()}`);
            │
            └─ the res.ok branch IS buffr's error contract with Ollama,
               inherited wholesale from the dependency
```

## Elaborate

HTTP's verb/status vocabulary (GET safe & idempotent, POST not, 2xx/3xx/4xx/5xx
classes) is the lingua franca of web APIs — but a JSON-RPC-style POST-only
client like Ollama's barely uses it. Ollama exposes `/api/chat`, `/api/embed`,
`/api/generate` as POST endpoints; it's REST-ish in transport but RPC in spirit.
The caching question (re-embedding identical text) connects to `study-
performance-engineering`; whether a remote Ollama would need auth headers (which
the current seam can't carry) connects to `study-security`.

## Interview defense

**Q: Does your app handle CORS?**

Answer: "No, and it shouldn't. CORS is a browser policy on cross-origin page
requests. My HTTP calls come from a Node process to a local Ollama — no browser,
no same-origin policy, so CORS is categorically irrelevant. It'd only matter if
I served a web UI." Anchor: no server in the repo; `src/cli/*`.

**Q: What's your error handling on the LLM HTTP call?**

```
  res.ok ? parse JSON : throw "ollama HTTP <status>: <body>"
```

Answer: "One status branch, inherited from aptkit's transport. `res.ok` means
parse the body; anything else throws an error with the status and response text.
There's no per-status logic — 404, 500, and 503 all become the same throw — and
no retry. For a single-user CLI that surfaces-and-exits, that's adequate." Anchor:
aptkit transport behind `src/cli/ask-cmd.ts:26`. → `07`.

## Validate

1. **Reconstruct:** the request/response kernel — method+path+body / status+body.
2. **Explain:** why is CORS irrelevant to buffr? (Node origin, not a browser.)
3. **Apply:** Ollama returns 503 (model loading). What does buffr do? (throws
   "ollama HTTP 503: ...", CLI exits; no retry — `07`.)
4. **Defend:** why no caching on the embed POST? (POSTs aren't cacheable by
   default; neither layer memoizes — a perf note, not a bug.)

## See also

- `06-websockets-sse-streaming-and-realtime.md` — why the chat response isn't streamed.
- `07-timeouts-retries-pooling-and-backpressure.md` — what happens when these POSTs hang.
- `study-security` — auth headers the current host-only seam can't carry.
- `study-performance-engineering` — re-embedding identical text.
