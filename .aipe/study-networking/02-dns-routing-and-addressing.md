# DNS, Routing & Addressing — where the bytes actually go

**Name resolution & host addressing** · Industry standard

## Zoom out, then zoom in

Before any byte moves, the OS has to turn a *name* into an *address*. buffr does
this twice, and the two cases could not be more different — one resolves to
your own machine and never hits a network card; the other resolves to a server
somewhere on Supabase's infrastructure across the open internet.

```
  Zoom out — where addressing happens

  ┌─ Provider layer ────────────────────────────────────────────────┐
  │   Postgres @ <supabase-host>           Ollama @ localhost        │
  └──────┬──────────────────────────────────────┬──────────────────┘
         │                                       │
  ┌─ Addressing / resolution ───────────────────────────────────────┐
  │   DNS lookup → real IP → route          /etc/hosts → 127.0.0.1   │ ★ THIS FILE ★
  │   over the internet                     loopback, no routing     │
  └──────┬──────────────────────────────────────┬──────────────────┘
         │                                       │
  ┌─ Service layer ─────────────────────────────────────────────────┐
  │   DATABASE_URL host:port (src/config.ts:11) OLLAMA_HOST (:14)    │
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in: addressing answers "*which machine?*" — and the question splits the
moment you compare `localhost:11434` against a Supabase hostname. Same line of
config, two completely different resolution paths.

## Structure pass

**Layers.** Config string → resolver → IP → route. Trace the *cost* axis down
it.

**Axis — "what does resolution cost?"**

```
  One question, two answers — the addressing seam

  "what does resolving this name cost?"

  ┌─ OLLAMA_HOST = http://localhost:11434 ──┐
  │  resolve: /etc/hosts → 127.0.0.1        │  → ~0, no network, cached forever
  └──────────────────────────────────────────┘
           ║  the seam: loopback vs internet
  ┌─ DATABASE_URL = ...@<host>:5432 ────────┐
  │  resolve: DNS query → recursive lookup  │  → a real round-trip, TTL-cached,
  │  → public IP → route over internet      │     can fail (NXDOMAIN, timeout)
  └──────────────────────────────────────────┘
```

**Seam.** The load-bearing seam is `localhost` vs a public hostname. The axis
"can resolution fail?" flips across it: `localhost` essentially cannot fail to
resolve (it's in `/etc/hosts`); the Supabase host can fail in three distinct
ways — DNS down, wrong name, or resolves-but-unroutable. That flip is why one
wire needs failure handling and the other doesn't.

## How it works

### Move 1 — the mental model

DNS is a lookup table you don't own, queried over the network, with a cache in
front. You already know this shape: it's a `Map<name, ip>` where the map lives
on someone else's server and entries expire (TTL).

```
  The resolution kernel

  name ──► [ local cache? ] ──hit──► IP  (fast path, no network)
              │ miss
              ▼
          [ recursive resolver ] ──► root → TLD → authoritative ──► IP
              │                                                       │
              └──────────────── cache with TTL ◄──────────────────────┘

  localhost short-circuits the whole thing at /etc/hosts.
```

### Move 2 — the two resolution paths

**Loopback — `localhost` never reaches a resolver.** `OLLAMA_HOST` defaults to
`http://localhost:11434` (`src/config.ts:14`). The name `localhost` is mapped in
the OS hosts file to `127.0.0.1` (and `::1`). The kernel sees a loopback
address and short-circuits: the packet goes down the network stack and right
back up — it never reaches a network interface, never touches DNS, never has a
route to compute.

```
  Loopback — the packet that never leaves

  ┌─ buffr process ─┐  POST /api/embed   ┌─ Ollama process ─┐
  │  fetch(...)     │ ─────────────────► │  :11434 listener │
  └────────┬────────┘                    └─────────┬────────┘
           │  127.0.0.1                            │
           └──────────► [ kernel loopback ] ◄──────┘
                        no NIC, no DNS, no route
```

The consequence: the Ollama wire has no DNS failure mode, near-zero address
latency, and — this matters for `04` — no meaningful reason for TLS.

**Remote — the Supabase host goes through real DNS.** `DATABASE_URL` is
`postgres://USER:PASSWORD@HOST:PORT/reindb` (from `.env.example`). The `HOST`
is a public Supabase hostname. node-postgres hands that hostname to the OS
resolver, which does the recursive walk (or hits its cache), gets a public IP,
and routes the TCP SYN out your default gateway across the internet.

```
  Remote — the Supabase host resolution + route

  ┌─ buffr ─┐  connect(HOST:5432)   ┌─ OS resolver ─┐  DNS   ┌─ DNS infra ─┐
  │ pg.Pool │ ───────────────────►  │  cache miss   │ ─────► │ root/TLD/   │
  └─────────┘                       └───────┬───────┘        │ authoritative│
                                            │  IP            └─────────────┘
                                            ▼
                                    route over internet ──► Supabase
```

The consequence: this wire *can* fail at the name layer (typo'd host →
`ENOTFOUND`, DNS outage → timeout), and the repo has no handling for it — the
error propagates raw out of `pool.query` and crashes the CLI.

### Move 2.5 — current vs future addressing

Right now both endpoints are config strings with hardcoded defaults; there's no
service discovery, no DNS-based load balancing, no proxy. The context.md's "no
Edge Functions this phase" is the tell — a future phase that puts buffr behind
an edge or splits Ollama onto another host would introduce real routing
decisions (which replica? which region?). Today: two names, two static
resolutions, done.

### Move 3 — the principle

The address layer is where "it works on my machine" lives and dies. `localhost`
is the safest address in computing — it can't be misrouted — which is exactly
why local-first tools lean on it. The instant a name points off-box, you've
inherited DNS's entire failure surface. Knowing *which* of your endpoints is
loopback and which is remote tells you, before you write a line of error
handling, where the failures will come from.

## Primary diagram

Both resolution paths, side by side, with the cost and failure contrast.

```
  buffr's two names — resolution side by side

  OLLAMA_HOST = localhost:11434        DATABASE_URL host = <supabase>:5432
  ┌────────────────────────┐          ┌────────────────────────────────┐
  │ /etc/hosts → 127.0.0.1 │          │ OS resolver → DNS → public IP   │
  │ kernel loopback        │          │ route over internet             │
  │ cost: ~0               │          │ cost: a real round-trip (cached)│
  │ failure: ~none         │          │ failure: NXDOMAIN, timeout,     │
  │                        │          │          unroutable             │
  └────────────────────────┘          └────────────────────────────────┘
  src/config.ts:14                     src/config.ts:11  (.env DATABASE_URL)
```

## Implementation in codebase

**Use cases.** Resolution happens implicitly on the first query/fetch of every
CLI. There is no explicit DNS code in the repo — addressing is entirely
delegated to the OS via the host strings.

**Code side by side.** The entire addressing surface is two lines of config:

```
  src/config.ts  (lines 10–15)

  databaseUrl: env.DATABASE_URL || undefined,   ← remote host lives INSIDE
                                                   this URL: user:pw@HOST:PORT
  ...
  ollamaHost: env.OLLAMA_HOST || 'http://localhost:11434',
        │                                  │
        │                                  └─ loopback default — resolves
        │                                     to 127.0.0.1, never hits DNS
        └─ the remote host is opaque to buffr: it's a substring of the
           connection string, parsed by node-postgres, resolved by the OS
```

Note buffr never *parses* the DB host — it passes the whole `connectionString`
to `pg.Pool` (`src/db.ts:5`) and lets node-postgres pull the host out and
resolve it. buffr's addressing logic is: hand the OS two strings.

## Elaborate

DNS predates the web; it's the original distributed key-value store, designed
in the 80s precisely so humans wouldn't memorize IPs. The TTL-cache-with-
recursive-fallback shape shows up everywhere downstream (HTTP caching in `05`
is the same idea: cache with an expiry in front of an expensive lookup). The
loopback shortcut is a kernel optimization, not a DNS feature — `127.0.0.1` is
reserved by RFC and the OS knows never to route it. For buffr the practical
upshot is in `study-security`: the remote host carries credentials over the
internet (needs TLS), the loopback host carries them over a wire only processes
on your box can see.

## Interview defense

**Q: Your app talks to localhost and a remote host. What's different about
resolving them?**

```
  localhost ─► /etc/hosts ─► 127.0.0.1   (no network, can't fail)
  remote    ─► DNS recursive ─► public IP (round-trip, TTL, can fail 3 ways)
```

Answer: "`localhost` resolves from the hosts file to a loopback address and
never touches DNS or a NIC — it can't NXDOMAIN. The remote Supabase host goes
through the OS resolver and the real DNS hierarchy, so it can fail to resolve,
time out, or resolve to an unroutable IP. That asymmetry is why only the DB
wire needs network failure handling." Anchor: `src/config.ts:11,14`.

**Q: Where does buffr parse the database host?**

Answer: "It doesn't. It passes the whole `DATABASE_URL` to `pg.Pool` and lets
node-postgres extract and resolve the host. buffr's addressing surface is two
opaque strings." Anchor: `src/db.ts:5`.

## Validate

1. **Reconstruct:** name the two resolution paths and where each name comes from
   in `src/config.ts`.
2. **Explain:** why can `OLLAMA_HOST=localhost` never produce `ENOTFOUND` but
   the DB host can? (hosts-file vs DNS.)
3. **Apply:** you set `OLLAMA_HOST=http://ollama.local:11434` on a box with no
   such DNS entry — what happens? (resolution fails inside aptkit's `fetch`,
   error propagates; the loopback safety is gone.)
4. **Defend:** why is delegating host parsing to node-postgres the right call?
   (the connection-string format is pg's contract, not buffr's; `src/db.ts:5`.)

## See also

- `03-tcp-udp-connections-and-sockets.md` — what happens *after* the IP is known.
- `04-tls-and-trust-establishment.md` — why the remote name needs encryption and
  loopback doesn't.
- `study-security` — credentials traveling to the resolved remote host.
