# DNS, Routing, and Addressing

**Industry name(s):** name resolution / host addressing / origin
resolution. **Type:** Industry standard.

## Zoom out, then zoom in

Before any byte travels, the runtime has to turn a *name* into an
*address*. buffr names its two providers as strings — one a literal
`http://localhost:11434`, one whatever host is buried in `DATABASE_URL` —
and the runtime resolves each to an IP before opening a socket. Here's
where that naming lives.

```
  Zoom out — where addressing happens

  ┌─ Config layer ───────────────────────────────────────────┐
  │  src/config.ts                                           │
  │    ollamaHost = OLLAMA_HOST || 'http://localhost:11434'  │ ← ★ here
  │    databaseUrl = DATABASE_URL  (host embedded in URL)    │ ← ★ here
  └─────────────────────────────┬─────────────────────────────┘
                                │  name strings handed down
  ┌─ Transport layer (runtime / aptkit / pg / Node) ─────────┐
  │  resolve name → IP  →  open TCP socket                    │
  └─────────────────────────────┬─────────────────────────────┘
                                │
  ┌─ Network ────────────────────▼───────────────────────────┐
  │  loopback 127.0.0.1  (default)   or   a real DB host      │
  └──────────────────────────────────────────────────────────┘
```

Zoom in. The concept is **addressing**: how a human-readable name becomes
the IP a socket connects to. In this repo it's almost entirely the
*trivial* case — `localhost` — which is exactly why it's worth being
precise about what's happening, because the trivial case hides the
machinery that a real remote host would expose.

## Structure pass

**Layers.** Config (names as strings) → transport (resolution) → network
(IP). buffr owns only the top layer; it never resolves anything itself.

**Axis — "where does the name get turned into an address?"** Trace it:

```
  axis: "who resolves the name to an IP?"

  ┌─ config.ts ──────────────┐  → NOBODY (just a string)
  └──────────────────────────┘
  ┌─ pg / aptkit fetch ──────┐  → the LIBRARY asks the OS resolver
  └──────────────────────────┘
  ┌─ OS resolver ────────────┐  → localhost: hosts file → 127.0.0.1
  │                          │     real host: /etc/resolv.conf → DNS
  └──────────────────────────┘

  buffr never touches DNS; it only supplies the name
```

**Seam.** The load-bearing seam is config → transport: buffr's
responsibility *ends* at producing a correct name string. Everything past
that — resolution, routing, the socket — is the library's. That seam is
why "DNS" barely appears in buffr's code: the code lives entirely on the
naming side of it.

## How it works

### Move 1 — the mental model

You've typed `fetch('http://localhost:3000/api')` a thousand times. You
never wrote the DNS lookup — the browser/runtime did it. buffr is
identical: it produces the URL/host string and hands it to a library that
does the lookup. The only thing worth learning here is *what the name
resolves to* in each of the two cases, because the default (`localhost`)
and the realistic alternative (a remote DB) resolve through completely
different paths.

```
  Resolution paths — two names, two routes

  name "localhost"  ──► hosts file (/etc/hosts) ──► 127.0.0.1
                        (no DNS query leaves the box)

  name "db.example"  ─► resolver (/etc/resolv.conf) ─► DNS server
                        ──► A/AAAA record ──► public IP
```

### Move 2 — walk the addressing

**Ollama: a hard-coded loopback host.** `src/config.ts:14` —
`ollamaHost: env.OLLAMA_HOST || 'http://localhost:11434'`. The default
name is `localhost`. `localhost` is *not* a DNS name in practice — it's an
entry in the OS hosts file that maps to `127.0.0.1` (loopback). No DNS
query leaves the machine. The packet never touches a network card; the
kernel loops it back internally. This is the cheapest possible "network"
hop and the reason the missing TLS (file `04`) is defensible: there's no
wire to sniff.

```
  Ollama addressing — name to loopback, no DNS

  ┌─ config.ts:14 ─────┐  "http://localhost:11434"
  │ ollamaHost         │ ──────────────┐
  └────────────────────┘               │ aptkit fetch()
                                       ▼
                              OS hosts file lookup
                                       │ localhost → 127.0.0.1
                                       ▼
                              kernel loopback (lo0) — no NIC, no DNS
                                       ▼
                              Ollama listening on 127.0.0.1:11434
```

The override path matters: set `OLLAMA_HOST=http://192.168.1.50:11434`
and the same code now addresses another box on your LAN — still no DNS
(it's already an IP), but now real packets on a real interface. Set a
hostname and *now* the resolver runs. buffr's code doesn't change; the
string does. That's the whole point of keeping the host in config.

**Postgres: the host is hidden inside the connection string.** `src/db.ts`
passes `connectionString: databaseUrl` to `pg.Pool`. The host isn't a
separate field — it's a component of the URL
(`postgres://user:pass@HOST:5432/reindb?sslmode=...`). node-postgres parses
the URL, extracts the host, and resolves it. With a local Postgres the
host is `localhost` (hosts file again). With a remote/managed Postgres —
the realistic Supabase case the project context names — the host is a real
DNS name, and *this* is the one place in the entire repo where a genuine
DNS query would leave the machine.

```
  Postgres addressing — host extracted from the URL

  DATABASE_URL = postgres://u:p@HOST:5432/reindb?sslmode=require
                                  └─┬─┘
  ┌─ db.ts:4-5 ──────────┐        │ pg parses URL, pulls host
  │ new pg.Pool({         │        ▼
  │   connectionString }) │   resolve HOST:
  └───────────────────────┘     localhost → 127.0.0.1 (hosts file)
                                 db.foo.supabase.co → DNS A record
                                          ▼
                                 open TCP to resolved IP : 5432
```

**Proxies, CDN, edge, load balancers — none.** There is no proxy config,
no edge layer, no LB. Both connections are direct: process → resolved IP →
provider. A managed Postgres might sit behind the provider's own
connection pooler/proxy (e.g. a PgBouncer endpoint), but that's
*their* infrastructure reached as a normal host — buffr neither knows nor
configures it. From buffr's side it's one direct connection to one host.
`not yet exercised`: any proxy/edge buffr itself stands up or routes
through.

### Move 3 — the principle

**Keep names in config, not in code, and resolution stops being your
problem.** buffr never writes a DNS lookup, yet it works against
loopback, a LAN IP, or a remote DNS-named host — because the only thing
that changes is a string in `.env`. The code lives on the naming side of
the resolution seam, and that's what makes the same code portable across
all three addressing cases.

## Primary diagram

Both providers' addressing in one frame.

```
  Addressing — both boundaries, name → IP → socket

  ┌─ config.ts ──────────────────────────────────────────────┐
  │  ollamaHost  = "http://localhost:11434"   (:14)          │
  │  databaseUrl = "postgres://…@HOST:5432/…" (:11, in URL)  │
  └───────┬───────────────────────────────────┬──────────────┘
          │ host string                        │ host inside URL
          ▼ aptkit fetch                        ▼ pg.Pool parses
   ┌─ resolver ─────────┐              ┌─ resolver ───────────┐
   │ localhost          │              │ localhost → hosts    │
   │   → hosts file     │              │ OR db host → DNS ★   │
   │   → 127.0.0.1      │              │   (only real DNS hit │
   └────────┬───────────┘              │    in the whole repo)│
            │ TCP 11434                └─────────┬────────────┘
            ▼                                    │ TCP 5432
     Ollama (loopback)                           ▼
                                          Postgres (local or remote)
```

## Elaborate

The reason `localhost` resolving via the hosts file (not DNS) matters:
it's instant, it never fails on a flaky network, and it can't be
intercepted off-box. Most of buffr's "no timeouts / no retries"
posture (file `07`) is *survivable* precisely because the default
addressing is loopback — there's no DNS latency, no resolution failure, no
route flap to retry around. Point `DATABASE_URL` at a remote DNS host and
that assumption evaporates: now DNS can be slow or fail, and the absence
of timeouts becomes a real risk. Addressing and resilience are coupled.

## Interview defense

**Q: "Does this app do DNS resolution?"**

> Effectively no, in the default config. Ollama is `localhost`, which
> resolves via the hosts file to 127.0.0.1 — no DNS query leaves the box.
> Postgres' host lives inside `DATABASE_URL`; if that points at localhost
> it's the hosts file again. The only real DNS hit is when `DATABASE_URL`
> names a remote host — a managed Postgres — and even then pg and the OS
> resolver do it, not buffr's code.

```
  localhost → hosts file → 127.0.0.1   (no DNS)
  remote DB host → resolver → DNS → public IP   (the one real lookup)
```

Anchor: *"`config.ts:14` defaults to `localhost`; the only DNS surface is
a remote host in `DATABASE_URL`."*

## See also

- `01-network-map.md` — the boundaries these names address.
- `03-tcp-udp-connections-and-sockets.md` — the socket opened to the
  resolved IP.
- `04-tls-and-trust-establishment.md` — `sslmode` lives in the same
  `DATABASE_URL` that carries the host.
- `study-security` — `DATABASE_URL` as a secret; host trust.
