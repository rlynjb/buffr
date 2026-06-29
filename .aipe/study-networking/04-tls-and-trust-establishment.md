# TLS and Trust Establishment

**Industry name(s):** transport encryption / TLS termination / connection
trust. **Type:** Industry standard.

## Zoom out, then zoom in

buffr has exactly one connection that *can* be encrypted — Postgres on
5432 — and the decision to encrypt it is made **entirely by the connection
string**, never by code. The Ollama connection is plaintext loopback and
has no TLS at all. The interesting thing here is an *absence in the code*
that is a *presence in config*: buffr is deliberately TLS-agnostic.

```
  Zoom out — where the TLS decision lives

  ┌─ Config layer ───────────────────────────────────────────┐
  │  DATABASE_URL = postgres://…@host:5432/reindb?sslmode=X   │ ← ★ TLS
  │                                          └────┬────┘      │   decided
  │  ollamaHost  = http://localhost:11434  (no TLS, ever)    │   HERE
  └─────────────────────────────┬─────────────────────────────┘
                                │  string handed to pg.Pool
  ┌─ Transport (pg / node) ─────▼────────────────────────────┐
  │  reads sslmode → maybe TLS handshake → encrypted socket  │
  └─────────────────────────────┬─────────────────────────────┘
                                ▼
  ┌─ Postgres ───────────────────────────────────────────────┐
  │  TLS terminates HERE (at the DB, not at a proxy)          │
  └──────────────────────────────────────────────────────────┘
```

Zoom in. The concept is **trust establishment**: before sending a
password and queries, the client wants assurance the bytes are encrypted
and the server is who it claims. TLS does both. buffr's stance is that
*the operator* decides this via `sslmode=` in the URL, and the code stays
out of it.

## Structure pass

**Layers.** Config (the `sslmode` token) → pg (reads it, runs or skips the
handshake) → TCP (carries the now-maybe-encrypted bytes).

**Axis — trust / "can a third party read or tamper with these bytes?"**
Trace it across the two boundaries and watch it flip on `sslmode`:

```
  axis: "can a third party read these bytes?"

  ┌─ Ollama (loopback) ─────────┐  → NO third party EXISTS
  │ 127.0.0.1, kernel loopback  │     (bytes never leave the box)
  └─────────────────────────────┘
  ┌─ Postgres, sslmode=disable ─┐  → YES, plaintext on the wire
  └─────────────────────────────┘
  ┌─ Postgres, sslmode=require+ ┐  → NO, TLS-encrypted
  └─────────────────────────────┘

  the trust answer is set by a STRING, not by buffr's code
```

**Seam.** The seam is the `connectionString` handoff in `db.ts`. Above it
buffr knows nothing about encryption; below it pg parses `sslmode` and
decides. That seam is load-bearing precisely because the trust axis flips
across it based on a value buffr passes through blindly.

## How it works

### Move 1 — the mental model

TLS is the `https://` vs `http://` choice, pushed down to the database
connection. Same as in the browser: you don't write the handshake, you
just pick the scheme and the library does the rest. For Postgres the
"scheme" is the `sslmode` query parameter in the URL, and pg is the
library that acts on it.

```
  The TLS decision — one token drives the whole handshake

   DATABASE_URL ?sslmode=...
        │
        ├─ disable / (absent) ──► plaintext TCP, no handshake
        │
        ├─ require ─────────────► TLS handshake, encrypt,
        │                          but DON'T verify the cert
        │
        └─ verify-full ─────────► TLS handshake, encrypt,
                                   AND verify cert + hostname
```

### Move 2 — walk the trust establishment

**The code is TLS-blind — and that's the whole design.** Look at the
entire database entry point, `src/db.ts:4-6`:

```
  src/db.ts:4-6 — no ssl object, by design

  export function createPool(databaseUrl: string): pg.Pool {
    return new pg.Pool({ connectionString: databaseUrl });
  }
  //                    ▲
  //   NO { ssl: {...} } here. pg reads sslmode FROM the
  //   connectionString. buffr never sees or sets a TLS flag.
```

There is no `ssl: { rejectUnauthorized: ... }`, no cert path, no CA
bundle. node-postgres parses `sslmode` out of the URL itself and
configures TLS accordingly. So the question "is buffr's DB connection
encrypted?" has no answer in buffr's code — the answer lives in whatever
`.env` ships. The project context confirms this is intentional: secrets
(including the full `DATABASE_URL`) live in `.env`, gitignored, never
committed.

**What each `sslmode` actually buys.** This is the part to be precise
about, because "I set sslmode=require, so I'm secure" is a common
half-truth:

```
  sslmode levels — encryption vs verification

  ┌──────────────┬────────────┬───────────────────────────────┐
  │ sslmode      │ encrypted? │ verifies server identity?     │
  ├──────────────┼────────────┼───────────────────────────────┤
  │ disable      │ no         │ no                            │
  │ require      │ YES        │ NO ← encrypted but MITM-able  │
  │              │            │      (accepts any cert)       │
  │ verify-ca    │ YES        │ cert chain only               │
  │ verify-full  │ YES        │ cert chain + hostname ★       │
  └──────────────┴────────────┴───────────────────────────────┘
```

The trap: `require` encrypts but accepts *any* certificate, so a
man-in-the-middle with any cert can sit between you and the DB and read
everything. Only `verify-full` checks that the cert chains to a trusted CA
*and* matches the hostname. For a remote managed Postgres,
`verify-full` is the one you want. Whether buffr's `.env` uses it is a
*security-posture* question — that verdict belongs to **`study-security`**.
This file's job is to make clear that buffr's code imposes *no* floor:
ship `sslmode=disable` and the code happily sends your DB password in
plaintext.

```
  Trust establishment — config decides, code carries

  ┌─ .env ──────────┐ sslmode=verify-full   ┌─ pg.Pool ──────────┐
  │ DATABASE_URL    │ ────────────────────► │ TLS handshake:     │
  └─────────────────┘                       │  · key exchange    │
                                            │  · verify cert+host│
                                            └─────────┬──────────┘
                                                      │ encrypted
                                                      ▼ TCP 5432
                                            ┌─ Postgres ─────────┐
                                            │ TLS terminates HERE│
                                            └────────────────────┘
```

**Where TLS terminates: at the database.** There's no proxy, no edge, no
TLS-terminating load balancer in buffr's path (file `02`). The encrypted
tunnel runs process → Postgres directly. The DB is the termination point.
(A managed provider may terminate at *their* pooler first, but that's
their topology, transparent to buffr.)

**Ollama: no TLS, and that's fine.** `http://localhost:11434` — `http`,
not `https`, and `localhost`. The bytes never leave the machine (file
`02`: kernel loopback). There is no third party on a loopback connection
to encrypt against, so plaintext is correct, not negligent. The moment you
point `OLLAMA_HOST` at a *remote* `http://` box on a LAN, that reasoning
breaks — now it's plaintext over a real wire — but that's an operator
choice the code doesn't guard against. `not yet exercised`: TLS to Ollama
(`https://`), which Ollama would need a reverse proxy to even offer.

### Move 3 — the principle

**Push the encryption decision to configuration and the code becomes
portable across trust environments — at the cost of imposing no floor.**
buffr runs unchanged against a plaintext local DB and a `verify-full`
remote DB. The price: nothing in the code *forces* encryption, so the
security of the DB connection is exactly as good as the `.env` it ships
with. Portability bought, with a sharp edge left for the operator.

## Primary diagram

The complete trust picture, both boundaries.

```
  TLS & trust — both boundaries

  ┌─ Config ─────────────────────────────────────────────────┐
  │  DATABASE_URL ?sslmode=X   →  drives DB TLS               │
  │  ollamaHost = http://localhost  →  no TLS, loopback       │
  └───────┬───────────────────────────────────┬──────────────┘
          │ pg reads sslmode                   │ plain HTTP
   ┌──────▼───────────────────┐         ┌──────▼─────────────┐
   │ sslmode=disable → plain  │         │ 127.0.0.1:11434    │
   │ sslmode=require → enc,   │         │ no wire, no third  │
   │   NO cert check (MITM!)  │         │ party, no TLS need │
   │ sslmode=verify-full →    │         └────────────────────┘
   │   enc + cert + hostname ★│
   └──────────┬───────────────┘
              ▼ encrypted TCP 5432
        Postgres (TLS terminates here)
```

## Elaborate

The deeper point is *where* the encryption knob lives. Some apps hard-code
`ssl: { rejectUnauthorized: true }` in the pool options — that bakes a
trust policy into the binary. buffr does the opposite: zero TLS in code,
all of it in the URL. That's the right call for a tool that runs against
both a throwaway local DB and a real remote one, and it keeps the secret
and its transport policy together in one place (`.env`). It does mean the
code can't *enforce* `verify-full`, which is exactly the kind of finding
`study-security` exists to rank.

## Interview defense

**Q: "Is the database connection encrypted?"**

> The code doesn't decide — it's TLS-agnostic. `db.ts` passes the raw
> `connectionString` to `pg.Pool` with no `ssl` object, so pg reads
> `sslmode` out of `DATABASE_URL`. Plaintext against a local DB,
> encrypted against a remote one if the URL says `sslmode=require` or
> better. The code imposes no floor, which is portable but means security
> equals whatever `.env` ships.

```
  db.ts: new pg.Pool({ connectionString })   ← no ssl object
  sslmode in URL → require = encrypted-but-unverified (MITM)
                 → verify-full = encrypted + identity checked
```

Anchor: *"No `ssl` object in `db.ts`; `sslmode` in the URL is the only
TLS control, and `require` ≠ verified."*

**Q: "Why is the Ollama connection not HTTPS?"**

> It's loopback — `http://localhost:11434`. The bytes never leave the
> machine, so there's no third party to encrypt against. Plaintext is
> correct on loopback. It would only become a problem if you pointed
> `OLLAMA_HOST` at a remote plaintext box, which the code doesn't guard.

Anchor: *"`config.ts:14` — `http://localhost`; loopback has no wire to
sniff."*

## See also

- `02-dns-routing-and-addressing.md` — the host that `sslmode` and the
  cert hostname-check apply to.
- `03-tcp-udp-connections-and-sockets.md` — the TCP connection TLS wraps.
- `study-security` — *whether* the chosen `sslmode` is safe, secret
  handling for `DATABASE_URL`, the no-floor finding ranked as a risk.
