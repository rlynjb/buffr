# 02 · DNS, Routing, and Addressing

> Name resolution and the loopback interface (`localhost`) — Industry standard
> · the host string (`OLLAMA_HOST`) + the connection string (`DATABASE_URL`)

## Zoom out, then zoom in

Where does "addressing" even live in buffr? In exactly two strings: the host
the model server lives at, and the connection string the database lives at.
buffr does no routing, runs behind no proxy, sits behind no edge. Resolution is
whatever the OS does with two hostnames.

```
  Zoom out — addressing lives in two config values

  ┌─ Config layer (src/config.ts) ──────────────────────────────┐
  │  ★ ollamaHost  = "http://localhost:11434"   (line 14)       │
  │  ★ databaseUrl = process.env.DATABASE_URL   (line 12)       │
  └───────┬──────────────────────────────────┬──────────────────┘
          │ resolve "localhost"               │ resolve DB host
          ▼                                   ▼
  ┌─ Loopback interface ────┐         ┌─ Resolver (OS / DNS) ────┐
  │  127.0.0.1 / ::1        │         │  host inside DATABASE_URL│
  │  → Ollama, never on NIC │         │  → Postgres (reindb)     │
  └─────────────────────────┘         └──────────────────────────┘
```

Zoom in: addressing is the step *before* any connection — turning a name into an
address the kernel can dial. The loopback interface (`localhost`) is the
interesting case, because it's a name that deliberately never leaves the machine.

## Structure pass

**Layers.** Config (two strings) → Resolution (OS resolver / loopback) →
Transport (the actual socket, covered in `03`). This file owns the middle layer
only.

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
```

**Seam.** The load-bearing seam is the loopback boundary itself: `localhost`
resolves *without DNS* — the OS short-circuits it to the loopback interface.
That's why the model server has effectively zero name-resolution latency and
zero DNS-failure surface.

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

### Move 2.5 — current vs future

Phase A (now): both endpoints are effectively local. `localhost` for Ollama is
loopback by definition; the DB is single-device. No DNS on the wire, no resolver
failure mode.

Phase B (if the DB moves off-box): the moment `DATABASE_URL` names a remote host,
a real DNS lookup enters the path — and with it, resolution latency, TTL caching,
and a brand-new failure mode (NXDOMAIN, resolver timeout) that buffr has no
handling for. What *doesn't* change: the Ollama path stays loopback; buffr's code
stays identical (it already just passes strings through).

### Move 3 — the principle

Addressing is the cheapest place to make a system local-first: point everything
at loopback or the same LAN and the entire class of DNS/routing/edge failures
disappears. buffr gets this for free on the model path and inherits it (probably)
on the DB path — but only the model path is *guaranteed* loopback by the literal
`localhost`.

## Primary diagram

```
  buffr addressing — recap

  Ollama:    "http://localhost:11434"  (src/config.ts:14)
             → loopback 127.0.0.1/::1, no DNS, no NIC

  Postgres:  host inside DATABASE_URL  (src/db.ts:4, opaque to buffr)
             → loopback / LAN today (inferred); DNS only if a remote name

  routing/proxy/CDN/edge/load-balancer:  not yet exercised
```

## Elaborate

`localhost` resolving without DNS is an OS guarantee (the loopback rule predates
DNS being on the hot path), which is why local model servers universally bind
there — zero resolution cost, and the loopback interface can't be reached from
off-box, so it's a free trust boundary. That last part (loopback as a security
boundary) is `study-security`'s to judge; this guide only notes that the address
itself never leaves the machine.

## Interview defense

**Q: Does buffr do any DNS resolution?**

Answer: "Effectively none. The model server is `localhost`, which the OS maps to
the loopback interface without a DNS query (`src/config.ts:14`). The database
host is hidden inside `DATABASE_URL` and parsed by node-postgres; for a
single-device setup it's loopback or LAN, so still no real DNS — but buffr can't
see the host, so that's inferred from the design, not pinned by code."

```
  "localhost" → loopback rule → 127.0.0.1, no DNS query emitted
```

**Q: What changes if you move Postgres to a remote host?**

Answer: "A real DNS lookup enters the connect path, adding resolution latency and
a new failure mode buffr doesn't handle (NXDOMAIN, resolver timeout). The code
doesn't change — buffr already just passes the connection string through — but the
failure surface grows."

## See also

- `03-tcp-udp-connections-and-sockets.md` — what happens *after* the address resolves
- `04-tls-and-trust-establishment.md` — why a remote DB host makes sslmode urgent
- `study-security` — loopback as a trust boundary
