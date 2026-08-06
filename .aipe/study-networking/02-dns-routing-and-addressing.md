# 02 · DNS, Routing, and Addressing

> Name resolution — loopback for the model server, real DNS for everything else — Industry standard
> · the host string (`OLLAMA_HOST`), the connection string (`DATABASE_URL`), and six connector hostnames

## Zoom out, then zoom in

Where does "addressing" live in buffr? It used to be exactly two strings — the
model-server host and the database connection string — and that's what made
this file simple: no DNS ever really fired. That's no longer true. The six
connectors in `@buffr/connectors` each dial a real internet hostname —
`reddit.com`, `www.googleapis.com`, `api.search.brave.com`, `api.tavily.com`,
`www.amazon.com`, a caller-supplied RSS feed URL, and (indirectly) Google's
trends servers — and every one of those goes through a real DNS lookup before
the socket opens. buffr still does no routing and sits behind no proxy or edge
of its own, but "resolution is whatever the OS does" is now doing real work on
six hostnames, not zero.

```
  Zoom out — addressing lives in config strings AND connector hostnames

  ┌─ Config layer (src/config.ts) ──────────────────────────────┐
  │  ollamaHost  = "http://localhost:11434"   (line 14)          │
  │  databaseUrl = process.env.DATABASE_URL   (line 12)          │
  └───────┬──────────────────────────────────┬───────────────────┘
          │ resolve "localhost"               │ resolve DB host
          ▼                                    ▼
  ┌─ Loopback interface ────┐         ┌─ Resolver (OS / DNS) ─────────┐
  │  127.0.0.1 / ::1        │         │  host inside DATABASE_URL     │
  │  → Ollama, never on NIC │         │  → Postgres (reindb)          │
  └──────────────────────────┘         └─────────────────────────────┘

  ┌─ Connector hostnames (packages/connectors/src/discovery/*.ts) ────────┐
  │  ★ reddit.com · www.googleapis.com · api.search.brave.com ★          │
  │  ★ api.tavily.com · www.amazon.com · (caller-supplied RSS URL)  ★    │
  └───────┬────────────────────────────────────────────────────────────┘
          │ resolve each hostname — REAL DNS, every time
          ▼
  ┌─ Resolver (OS / DNS, over the real network) ──────────────────────────┐
  │  A/AAAA lookups leave the box; six independent name→address answers  │
  └─────────────────────────────────────────────────────────────────────┘
```

Zoom in: addressing is the step *before* any connection — turning a name into an
address the kernel can dial. Two distinct stories now live in this file: the
loopback interface (`localhost`), which is a name that deliberately never
leaves the machine, and the connector hostnames, which are ordinary internet
names resolved the ordinary way.

## Structure pass

**Layers.** Config / connector params (strings and hostnames) → Resolution (OS
resolver / loopback) → Transport (the actual socket, covered in `03`). This
file owns the middle layer only.

**Axis — trace `does this leave the machine?`**

```
  axis = "does resolution leave the box?"

  ┌─ Ollama host ──────────────┐   "localhost"
  │  → loopback 127.0.0.1/::1  │   NEVER leaves the box
  └────────────────────────────┘   (no DNS query on the wire)

  ┌─ Database host ────────────┐   host inside DATABASE_URL
  │  → could be localhost,     │   MAY leave the box, depending
  │    a LAN IP, or a DNS name │   on what the credential names
  └────────────────────────────┘

  ┌─ Connector hosts ──────────┐   reddit.com, googleapis.com, …
  │  → real internet hostnames │   ALWAYS leaves the box — every
  │                             │   /research or /investing turn
  └────────────────────────────┘   fires up to 6 real DNS lookups
```

The axis genuinely three-way flips now: never (Ollama) / maybe (Postgres) /
always (connectors). That's the single biggest correction this file needed —
it previously read as if nothing in the repo ever left the box.

**Seam.** Two load-bearing seams. The loopback boundary: `localhost` resolves
*without DNS* — the OS short-circuits it to the loopback interface, so the
model server has zero name-resolution latency and zero DNS-failure surface.
And the connector boundary: each connector hardcodes (or, for RSS, accepts as
a parameter) a real hostname, so every `/research`/`/investing` turn pays a
real resolver round-trip per source, in parallel, with real failure modes
(NXDOMAIN, resolver timeout) that buffr has no explicit handling for.

## How it works

### Move 1 — the mental model

You know how typing `localhost:3000` in a browser hits your own dev server
without ever touching the internet? Same primitive here. `localhost` is a
reserved name the OS maps to the loopback interface — a virtual network device
that loops packets straight back to the kernel. No router, no DNS server, no
NIC.

```
  Pattern — loopback short-circuits the resolver

   "localhost"
       │
       ▼ (OS hosts file / built-in rule, NOT a DNS query)
   127.0.0.1  (IPv4)  or  ::1  (IPv6)
       │
       ▼
   loopback interface  ──►  kernel  ──►  Ollama on :11434
       (packets never reach a network card)
```

### Move 2 — the walkthrough

**The model-server address is one literal string.** buffr never parses a URL,
never does a manual lookup. It hands the host straight to aptkit
(`src/config.ts:14`):

```ts
ollamaHost: env.OLLAMA_HOST || 'http://localhost:11434',
```

That string flows into both providers verbatim (`src/session.ts:40,46`):

```ts
const embedder = new OllamaEmbeddingProvider({ model: '…', host: cfg.ollamaHost });
const model = new ContextWindowGuardedProvider(new GemmaModelProvider({ host: cfg.ollamaHost }), …);
```

Inside aptkit, `defaultHttpTransport` strips a trailing slash and appends the
path — `fetch(\`${base}/api/chat\`)`. The *resolution* of `localhost` happens
inside `fetch` → Node's network stack → the OS, which sees `localhost` and uses
the loopback rule rather than emitting a DNS query. So the model server has no
DNS dependency at all.

**The database address is opaque to buffr.** buffr never sees the host — it's
buried inside `DATABASE_URL` and parsed by node-postgres, not by buffr
(`src/db.ts:4`):

```ts
return new pg.Pool({ connectionString: databaseUrl });
```

Whether that host is `localhost`, a `192.168.x.x` LAN address, or a real DNS
name like `db.internal.example.com` is decided entirely by the credential. If
it's a DNS name, *then* a real lookup happens — and DNS-resolution latency and
failure become real. Today, for a single-device setup, it's almost certainly
loopback or a local socket, so the same "no real DNS" property holds. But this is
**inferred** from the single-device design, not pinned by code — buffr can't see
the host.

```
  Layers-and-hops — two addresses, two resolution paths

  ┌─ Config ──────────────────────────────────────────┐
  │ ollamaHost "localhost"   databaseUrl (host hidden) │
  └───┬───────────────────────────────┬────────────────┘
      │ loopback rule                  │ resolver (DNS if a name)
      ▼                                ▼
  ┌─ Loopback ──────┐            ┌─ OS resolver ───────┐
  │ 127.0.0.1 / ::1 │            │ name → A/AAAA record │
  │ → Ollama        │            │ → Postgres           │
  └─────────────────┘            └──────────────────────┘
   no DNS, no failure             DNS only if host is a name
```

**The connector hostnames are real, and resolution is no longer theoretical.**
Five of the six connectors hardcode a literal hostname in the request URL —
Reddit's `defaultFetch` builds `https://www.reddit.com/search.json` or
`https://www.reddit.com/r/${subreddit}/search.json`
(`packages/connectors/src/discovery/reddit-search.ts:41-45`); Google Custom
Search hits `https://www.googleapis.com/customsearch/v1`
(`packages/connectors/src/discovery/google-search.ts:32`); Brave, Tavily, and
Amazon do the same for their own domains. RSS is the one connector where
**buffr's own code doesn't pick the hostname at all** — `RssConnector.fetch`
takes a caller-supplied `url` and passes it straight to `fetch(url, {
signal })` (`packages/connectors/src/discovery/news-rss.ts:24-28`); the routing
prompt in `src/session.ts` supplies a small allowlist of known-working feed
URLs, but nothing in the connector itself restricts which host that string can
name. Google Trends is the odd one out structurally: `GoogleTrendsConnector`
never calls `fetch` directly — it dynamically imports the `google-trends-api`
npm package and calls `interestOverTime()`
(`packages/connectors/src/discovery/search-trends.ts:66-72`), so the actual
hostname and DNS lookup are hidden inside a third-party library, the same
"buffr can't see the host" shape as the Ollama-via-aptkit boundary, just for a
different reason (an unofficial scraping wrapper, not a clean transport
abstraction).

```
  Layers-and-hops — six connector hostnames, six resolutions, one Promise.all

  ┌─ Collector.execute ───────────────────────────────────────────┐
  │  fires all sources concurrently                                │
  └──┬──────┬──────┬──────┬──────┬──────┬────────────────────────┘
     │      │      │      │      │      │
     ▼      ▼      ▼      ▼      ▼      ▼
  reddit  googleapis  brave.com  tavily.com  amazon.com  (RSS url)
  .com    .com                                            (caller-supplied
                                                             hostname)
     each: OS resolver → A/AAAA → TCP connect → TLS → HTTPS request
```

### Move 2.5 — current vs future

Phase A (now): the model server and (for a local single-device setup) the
database are effectively local — `localhost` for Ollama is loopback by
definition, no DNS, no resolver failure mode. The connectors are the opposite:
every `/research`/`/investing` turn resolves up to six real hostnames, over
the real network, with real resolver failure modes (NXDOMAIN, timeout) — and
none of that is handled explicitly; a resolver failure just surfaces as a
rejected `fetch()` inside `Collector.execute`'s `try/catch`.

Phase B (if the DB moves off-box too): the moment `DATABASE_URL` names a
remote host, a real DNS lookup enters that path as well — and with it,
resolution latency, TTL caching, and the same NXDOMAIN/timeout failure class
the connectors already exercise. What *doesn't* change: the Ollama path stays
loopback; buffr's code stays identical for both the DB and the connectors (it
already just passes hostnames through to `fetch`/`pg.Pool`).

### Move 3 — the principle

Addressing is the cheapest place to make a system local-first: point
everything at loopback or the same LAN and the entire class of DNS/routing/edge
failures disappears. buffr still gets that for free on the model path. But a
system that needs live evidence from the outside world can't stay local-first
on every arm — the connectors are a deliberate, bounded exception, and the
interesting design question isn't "why does buffr do DNS now" but "does it
handle DNS/resolver failure as gracefully as it handles the loopback case it
started with." Today the answer is no: a resolver failure on any connector is
just another uncaught-by-name rejection inside the fan-out.

## Primary diagram

```
  buffr addressing — recap

  Ollama:      "http://localhost:11434"  (src/config.ts:14)
               → loopback 127.0.0.1/::1, no DNS, no NIC

  Postgres:    host inside DATABASE_URL  (src/db.ts:4, opaque to buffr)
               → loopback / LAN today (inferred); DNS only if a remote name

  Connectors:  reddit.com, googleapis.com, api.search.brave.com,
               api.tavily.com, amazon.com, (RSS: caller-supplied host),
               google-trends-api (host hidden inside the library)
               → REAL DNS, every /research or /investing turn, up to 6 at once
               → resolver failures land as fetch() rejections, no special-casing

  routing/proxy/CDN/edge/load-balancer:  not yet exercised
```

## Elaborate

`localhost` resolving without DNS is an OS guarantee (the loopback rule predates
DNS being on the hot path), which is why local model servers universally bind
there — zero resolution cost, and the loopback interface can't be reached from
off-box, so it's a free trust boundary. That part still holds. What's new is
that buffr also now exercises the *ordinary* case: internet hostnames, resolved
the ordinary way, with the ordinary failure modes. The RSS connector is worth
flagging on its own — it's the one place a hostname isn't chosen by buffr's own
code but flows in as a parameter, which is the shape that matters most for
`study-security` (an unvalidated host string reaching `fetch`) even though this
guide's job is only to name that the DNS lookup happens, not judge whether it's
safe.

## Interview defense

**Q: Does buffr do any DNS resolution?**

Answer: "It didn't used to, in the plain chat path — Ollama is `localhost`
(loopback, no DNS), and the DB host is opaque but almost certainly local. That
changed with `/research` and `/investing`: every turn resolves up to six real
internet hostnames — Reddit, Google, Brave, Tavily, Amazon, and whatever RSS
URL was requested — through `Collector.execute`'s `Promise.all`. Five
connectors hardcode their host; RSS takes one as a parameter; Google Trends
hides its host inside the `google-trends-api` library."

```
  Ollama:      "localhost" → loopback rule → 127.0.0.1, no DNS query
  Connectors:  reddit.com / googleapis.com / … → real resolver, real network
```

**Q: What changes if you move Postgres to a remote host?**

Answer: "A real DNS lookup enters the connect path, adding resolution latency and
a new failure mode buffr doesn't handle (NXDOMAIN, resolver timeout). That's no
longer a hypothetical failure class for this repo — the connectors already hit
it on every `/research` turn, they just don't handle it specially either; it's
one more rejection inside the fan-out's `try/catch`."

## See also

- `03-tcp-udp-connections-and-sockets.md` — what happens *after* the address resolves
- `04-tls-and-trust-establishment.md` — why a remote DB host makes sslmode urgent, and how the connectors handle TLS by default
- `07-timeouts-retries-pooling-and-backpressure.md` — what a resolver failure or a hung connector does to the fan-out
- `study-security` — loopback as a trust boundary; the RSS connector's caller-supplied hostname
