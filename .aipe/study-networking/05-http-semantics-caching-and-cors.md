# 05 · HTTP Semantics, Caching, and CORS

> POST JSON to the local model server, GET/POST JSON (and one HTML scrape) to six real APIs — Industry standard
> · the model transport (`defaultHttpTransport`) lives in aptkit; the connector transports live in buffr's OWN `@buffr/connectors`

## Zoom out, then zoom in

buffr's HTTP used to be one shape: two POSTs to Ollama, `/api/chat` and
`/api/embed`, authored entirely by aptkit — buffr just supplied a host string.
That's still true for the model path. What's new: `/research` and
`/investing` now drive six more HTTP clients, and this time **buffr writes
the `fetch()` calls itself** — they live in `@buffr/connectors`, a package in
buffr's own monorepo, not a third-party dependency. That's a real ownership
flip worth naming precisely. CORS, cookies, and HTTP caching are still `not
yet exercised` — there's no browser and no inbound server, and none of that
changed by adding more outbound clients.

```
  Zoom out — HTTP lives one layer down for Ollama, but buffr owns it for connectors

  ┌─ Process layer (buffr) ───────────────────────────────────────────────┐
  │  cfg.ollamaHost = "http://localhost:11434"  ── src/config.ts:14        │
  │       │ passed to providers                                            │
  │       ▼                                                                │
  │  GemmaModelProvider / OllamaEmbeddingProvider  (aptkit, EXTERNAL)     │
  │       ▼  ★ defaultHttpTransport — buffr doesn't write this fetch() ★  │
  │                                                                        │
  │  RedditSearchConnector / GoogleSearchConnector / … (@buffr/connectors,│
  │       BUFFR'S OWN PACKAGE)                                            │
  │       ▼  ★ each connector's defaultFetch — buffr DOES write these ★  │
  └───────┬──────────────────────────────────────┬────────────────────────┘
          │ HTTP/1.1  POST json (Ollama)          │ HTTPS  GET/POST (6 APIs)
          ▼                                        ▼
   [ Ollama :11434 ]                        [ Reddit / Google / Brave /
   /api/chat   /api/embed                     Tavily / Amazon / Trends ]
```

Zoom in: HTTP semantics is the contract — method, headers, status, body. The
Ollama path still relies on a tiny slice of it (POST + JSON + a 2xx/non-2xx
split). The connector path exercises more of the protocol's surface — GET and
POST, JSON and HTML bodies, per-API auth headers, and — critically — six
different answers to "what do you do when the body isn't what you expected."

## Structure pass

**Layers.** buffr config → aptkit provider → aptkit transport (`fetch`) →
Ollama, for the model path. buffr's own connector code → `fetch` → the real
API, for the six connectors. Both layers terminate in the same primitive
(`fetch`); the difference is who authors the call sitting on top of it.

**Axis — trace `who owns the HTTP contract?`**

```
  axis = "who decides method / headers / status handling?"

  ┌─ buffr (Ollama path) ──┐  seam  ┌─ aptkit transport ────────┐
  │ supplies host string   │ ══════►│ POST, content-type: json, │
  │ ONLY                   │ (flips)│ res.ok check, res.json()  │
  └──────────────────────────┘        └────────────────────────────┘
   buffr owns 0% of this HTTP        aptkit (external) owns 100%

  ┌─ buffr (connector path) ──────────────────────────────────┐
  │ writes the fetch(), the headers, the status check,        │
  │ the body parse, the error message — for all six connectors│
  └─────────────────────────────────────────────────────────────┘
   buffr owns 100% of this HTTP — the axis genuinely flips
```

**Seam.** Two different seams now. On the Ollama path, the load-bearing seam
is still the provider boundary: buffr hands a host string across it and gets
back a typed result, a clean port/adapter split where buffr depends on the
provider interface, not on HTTP. On the connector path there's no such seam
inside buffr's own code — `@buffr/connectors` *is* the HTTP layer, which means
its `defaultFetch` functions are where non-2xx handling, malformed-body
handling, and header construction all actually live, in buffr's own repo,
answerable in this guide rather than deferred to `05`'s usual "ask the
dependency" shrug.

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

**The six connectors: same POST/GET-and-check shape, six different answers to
"what if the body is garbage."** Every connector follows the same skeleton —
build a URL, `fetch`, check `res.ok`, parse the body — but they diverge
exactly where it matters: what happens when the status is fine but the *body*
isn't what the code expects. This is the sharpest new HTTP-semantics lesson in
the repo, and it's worth walking connector by connector.

**Reddit — status-checked, but the JSON parse is unguarded.**
(`packages/connectors/src/discovery/reddit-search.ts:54-60`):

```ts
const res = await fetch(url.toString(), {
  headers: { 'User-Agent': 'buffr-research-bot/1.0' },   // ── Reddit rejects requests with no UA
  signal,
});
if (!res.ok) throw new Error(`Reddit search HTTP ${res.status}: ${await res.text()}`);

const json = await res.json() as Record<string, unknown>;   // ── UNGUARDED — throws SyntaxError if body isn't JSON
```

`res.ok` catches a 4xx/5xx. It does **not** catch the case Reddit is known to
return under rate-limiting or bot-detection: a `200 OK` whose body is an HTML
interstitial instead of the expected JSON listing. `res.json()` would throw a
raw `SyntaxError: Unexpected token '<'` in that case — a real failure mode,
just not one anyone has hit yet, filed here as `not yet exercised` (a latent
gap, not an observed crash).

**Google Trends — the exact same failure mode, and it's the one connector that
guards against it.** `search-trends.ts` doesn't call `fetch` directly (the
`google-trends-api` library does, hidden inside `interestOverTime()`), but the
raw response comes back as a string, and the fix added this pass checks it
before parsing (`packages/connectors/src/discovery/search-trends.ts:73-76`):

```ts
if (typeof raw === 'string' && raw.trimStart().startsWith('<')) {
  throw new Error('Google Trends returned an HTML page — likely rate-limited or blocked');
}
const parsed = JSON.parse(raw) as RawTimelineData;   // only reached once the shape is confirmed safe
```

This is content-sniffing where a `Content-Type` header isn't available to
trust (the library doesn't expose response headers) — instead of asking "does
the server claim this is JSON," it asks "does the body actually *look* like
JSON before I hand it to `JSON.parse`." That's a strictly better guard than a
`Content-Type` check would be here, because an untrusted or misbehaving
endpoint can lie about `Content-Type` but can't as easily fake "doesn't start
with `<`." **Reddit hits the identical class of endpoint failure — a public,
unauthenticated, rate-limited JSON API prone to returning an HTML block page —
and has no equivalent guard.** Same bug shape, fixed in one connector, not
yet applied to the other.

**Amazon — no JSON at all, so the failure mode is different: silent emptiness,
not a thrown error.** `AmazonReviewsConnector` always expects HTML (it's a
scrape, not an API) and parses with `cheerio`
(`packages/connectors/src/discovery/reviews/amazon.ts:57-70`):

```ts
const html = await this.transport(params.asin, opts?.signal);   // throws on non-2xx (same res.ok pattern)
const $ = load(html);                                            // cheerio never throws on "wrong" HTML
$('[data-hook="review"]').each((_i, el) => { … });                // if Amazon serves a CAPTCHA page, this
                                                                    // selector just matches ZERO elements
```

If Amazon serves a bot-check or CAPTCHA page instead of the review page (same
trigger as Reddit's and Trends's HTML-instead-of-JSON case), `cheerio` doesn't
throw — the selectors simply match nothing, and the connector returns `{
reviews: [] }` with no error at all. That's the third distinct failure shape
in this repo for the *same underlying event* (a scraped/public endpoint
returning a block page instead of real data): Reddit would crash on
`res.json()`, Trends explicitly catches and throws a clear error, Amazon
silently reports "zero reviews" as if that were a legitimate answer. Ranked by
how debuggable each is: Trends > Reddit > Amazon — the silent-empty case is
the one most likely to look like "this topic just has no reviews" instead of
"the fetch was blocked."

**Brave, Tavily, Google Custom Search, RSS — the same `res.ok` + typed-JSON
shape as Reddit**, with defensive `String(...)`/`Number(...)`/`?? []`
coercions on individual fields (so a missing field degrades to an empty
string/zero rather than throwing) but the same unguarded top-level
`res.json()` (or, for RSS, `XMLParser.parse`, which throws its own
`fast-xml-parser` error on malformed XML rather than silently returning
partial data). None of the six connectors validates the response
`Content-Type` header before choosing how to parse — every one infers the
shape from the request it made, not from what the server claims to have sent.

```
  Comparison — six connectors, three failure shapes for "the body lied"

   Reddit / Brave / Tavily / Google / RSS:  unguarded parse → THROWS (uncaught SyntaxError-class error)
   Google Trends:                            explicit body-sniff guard → THROWS a clear, named error
   Amazon:                                   cheerio never throws → SILENTLY returns empty results

   non-2xx handling: IDENTICAL across all six — `if (!res.ok) throw new Error(...)`
   the divergence is entirely in what happens when the status is 200 but the body isn't trustworthy
```

**CORS, cookies, caching — all absent, and correctly so.**

- **CORS is `not yet exercised`, and still has no home.** CORS is a *browser*
  enforcement — the browser refuses to let JS read a cross-origin response
  without the right `Access-Control-Allow-Origin` header. buffr is a Node
  process; `fetch` in Node doesn't enforce CORS. That's just as true for the
  six connectors reaching real cross-origin APIs as it was for Ollama — no
  browser anywhere in the process means CORS can't fire, full stop. It would
  only appear if buffr grew a browser frontend hitting these same APIs.
- **Cookies are `not yet exercised`.** No session cookie, no `Set-Cookie`
  handling, on any of the seven HTTP clients (Ollama plus six connectors). The
  calls are stateless GET/POSTs; identity is carried by API key query params
  (Google, Brave, Tavily) or not at all (Reddit's public JSON API, RSS,
  Amazon's scrape).
- **HTTP caching (the protocol mechanism — `Cache-Control`, `ETag`,
  conditional requests) is `not yet exercised`.** No connector reads or writes
  those headers. What *does* exist is an **application-level** cache one layer
  up: every connector is wrapped in `CachedConnector`, a 1-hour TTL
  key-by-params cache (`packages/connectors/src/cached-connector.ts:21-28`) —
  not HTTP caching, but the same *intent* (don't re-fetch identical work),
  implemented by buffr instead of delegated to the protocol. → `07` for the
  cache's role in reducing repeat network load.

### Move 3 — the principle

buffr depends on the *thinnest possible slice* of HTTP for the model path —
POST, JSON, ok/not-ok — and pushes that protocol into a transport it can swap.
For the connectors, buffr owns the whole slice itself, and the lesson that
surfaces is a general one: **checking `res.ok` is necessary but not
sufficient.** A 200 status only promises the server didn't error at the HTTP
layer; it says nothing about whether the *body* is the shape you asked for.
Google Trends is the one connector in this repo that learned that lesson in
code; the other five haven't hit the failure yet, which is different from
being safe from it.

## Primary diagram

```
  buffr HTTP — recap

  Ollama path — buffr writes NO fetch:
    cfg.ollamaHost = "http://localhost:11434"  (src/config.ts:14)
    aptkit transport: POST /api/chat / /api/embed → res.ok ? json() : throw

  connector path — buffr writes ALL SIX fetch()s (packages/connectors/src/discovery/*.ts):
    Reddit    GET  reddit.com/search.json        res.ok check, UNGUARDED json parse
    Google    GET  googleapis.com/customsearch    res.ok check, UNGUARDED json parse
    Brave     GET  api.search.brave.com/…         res.ok check, UNGUARDED json parse
    Tavily    POST api.tavily.com/search          res.ok check, UNGUARDED json parse
    RSS       GET  (caller-supplied url)          res.ok check, XML parser throws on malformed
    Amazon    GET  amazon.com/product-reviews/…   res.ok check, cheerio SILENTLY returns empty
    Trends    (google-trends-api, no raw fetch)   GUARDED — checks for HTML body before JSON.parse

  CORS:    not yet exercised (no browser, on any of the 7 clients)
  cookies: not yet exercised (stateless; identity via API-key query params)
  HTTP caching: not yet exercised — but app-level 1h TTL cache exists (CachedConnector)
```

## Elaborate

The provider/transport split aptkit uses is the standard way to keep an LLM
client testable: inject a fake transport in tests, use the real `fetch` in prod
(the `OllamaEmbeddingProvider` docstring literally says "pass `embed` to feed
recorded vectors in tests"). The connectors follow the identical shape at
buffr's own layer — every one takes an injectable `transport`/`call` function
defaulting to a real `fetch`, for the same testability reason. Where the two
paths diverge is failure handling: Ollama's non-2xx path is coarse by design
(one error class), which is fine for a single local server. The connectors
face six different public APIs with six different ways of failing softly —
rate limits that return HTML, bot-detection pages, malformed feeds — and
"check `res.ok`, then trust the body" is only a complete strategy for APIs that
never lie about their status code. The day one of the unguarded five hits a
rate-limited HTML response in production, the fix is a two-line copy of what
`search-trends.ts` already does.

## Interview defense

**Q: What HTTP does buffr actually speak?**

```
  Ollama:      POST /api/chat + POST /api/embed — buffr writes none of it
  Connectors:  6 clients, buffr writes ALL of them (@buffr/connectors)
```

Answer: "Two shapes. To Ollama, two POSTs — chat and embed — both JSON, but
buffr doesn't author the HTTP; the `fetch` lives in aptkit's
`defaultHttpTransport`, and buffr just supplies the host string
(`src/config.ts:14`). To the outside world, six connectors — Reddit, Google,
Brave, Tavily, RSS, Amazon — and this time buffr writes every `fetch()` call
itself, in `@buffr/connectors`."

**Q: How does buffr handle a CORS error from any of these APIs?**

Answer: "It can't get one — CORS is a browser enforcement and buffr is a Node
process, whether it's calling Ollama or Reddit. No browser in the loop means
CORS never fires for any of the seven HTTP clients." That's the load-bearing
distinction people miss: CORS is browser policy, not a server-side or
Node-`fetch` concern.

**Q: How are non-2xx and malformed responses handled?**

Answer: "Non-2xx is identical everywhere — every one of the seven clients
throws on `!res.ok`. Malformed-but-200 is where it gets interesting: five
connectors (Reddit, Brave, Tavily, Google, RSS) call `res.json()` or an XML
parser with no guard, so an API that returns an HTML block page instead of the
expected body throws an uncaught parse error. Google Trends is the one that
guards against exactly that — it checks whether the raw body starts with `<`
before calling `JSON.parse`, because the same library is known to return an
HTML page when rate-limited. Amazon is the third shape: it scrapes HTML with
`cheerio`, which never throws on unexpected markup, so a bot-check page just
produces zero reviews silently instead of an error. Three different answers to
the same underlying event." Anchor: `search-trends.ts:73-76` vs
`reddit-search.ts:60` vs `amazon.ts:64-85`.

## See also

- `06-websockets-sse-streaming-and-realtime.md` — why the chat response isn't streamed
- `07-timeouts-retries-pooling-and-backpressure.md` — the missing 429/timeout/retry handling, and the app-level cache
- `04-tls-and-trust-establishment.md` — the loopback Ollama path vs the connectors' default-verified HTTPS
- `study-security` — trusting the model server's and the connectors' responses; no auth on Reddit/RSS/Amazon
