# 04 · TLS and Trust Establishment

> Encryption in transit, gated by connection string (`sslmode`) — Industry standard
> · no TLS code, only the credential (`DATABASE_URL`)

## Zoom out, then zoom in

Here's the verdict up front: **buffr has zero TLS code.** Whether the pg-wire
connection is encrypted is decided entirely by one parameter inside
`DATABASE_URL` — `sslmode`. The model path is plain HTTP over loopback, no TLS at
all. So "trust establishment" in this repo is a config story, not a code story.

```
  Zoom out — TLS is decided in the credential, not in code

  ┌─ Config layer ──────────────────────────────────────────────┐
  │  DATABASE_URL  ──►  postgres://…?sslmode=require             │
  │                              ▲                               │
  │                    ★ TLS policy lives HERE ★                 │
  └───────┬──────────────────────────────────┬──────────────────┘
          │ pg-wire: TLS iff sslmode says so  │ HTTP: plaintext
          ▼                                   ▼
   [ Postgres ]                         [ Ollama on localhost ]
   STARTTLS-style upgrade per sslmode   no TLS (loopback)
```

Zoom in: TLS establishes two things — that the bytes are encrypted, and that the
peer is who it claims (certificate verification). For buffr, both are dialed by
the `sslmode=` value, and node-postgres does all the work.

## Structure pass

**Layers.** Credential (the URL) → Driver (node-postgres reads `sslmode`) →
TLS handshake (if enabled) → encrypted pg-wire. buffr touches only the top layer
(it holds the credential); everything below is the driver.

**Axis — trace `trust` across the two boundaries.**

```
  axis = "is the peer authenticated and the channel encrypted?"

  ┌─ pg-wire boundary ─────────┐   seam   ┌─ HTTP boundary ───────┐
  │ depends on sslmode:         │ ════════►│ NO TLS                │
  │  disable → none             │ (flips)  │ plaintext over        │
  │  require → encrypted        │          │ loopback              │
  │  verify-full → + cert check │          │ (no peer to verify)   │
  └─────────────────────────────┘          └────────────────────────┘
```

**Seam.** The load-bearing seam is `sslmode` itself — it's the one knob where the
trust axis flips from "plaintext" to "encrypted" to "encrypted + verified." And
critically: that knob is in a *secret*, not in source, so the same binary behaves
differently per deployment.

## How it works

### Move 1 — the mental model

You know how `https://` vs `http://` in a URL flips a request from plaintext to
encrypted without you writing any crypto? `sslmode` is that switch for Postgres —
except it has *gradations*, not just on/off. The kernel is a negotiation: the
driver asks Postgres "can we do TLS?", and based on `sslmode` it either insists,
prefers, or skips.

```
  Pattern — sslmode gradient (least → most trust)

   disable      → plaintext only.            no encryption.
   prefer       → TLS if server offers, else plaintext.   (silent downgrade)
   require      → TLS required.              encrypted, but cert NOT verified.
   verify-ca    → TLS + cert chains to a trusted CA.
   verify-full  → TLS + CA + hostname matches cert.   ← strongest
```

Each step up the gradient closes one attack: `require` stops passive sniffing;
`verify-full` stops an active man-in-the-middle presenting a valid-but-wrong cert.

### Move 2 — the walkthrough

**buffr never writes `ssl`.** The entire connection setup is the connection
string, untouched (`src/db.ts:4`):

```ts
return new pg.Pool({ connectionString: databaseUrl });
```

There is no `ssl: { rejectUnauthorized: … }`, no `ca:`, no cert path — anywhere
in the repo. node-postgres parses `sslmode` out of the connection string and runs
the whole TLS handshake itself. So buffr's TLS posture is *exactly* whatever the
operator put in `DATABASE_URL`, and buffr's code can't tell you what that is.

```
  Layers-and-hops — sslmode drives the handshake buffr never sees

  ┌─ buffr ────────────────────┐
  │ new pg.Pool({connectionString})  ── src/db.ts:4
  └──────────┬─────────────────┘
             │ hop 1: driver parses sslmode= from the URL
             ▼
  ┌─ node-postgres driver ─────┐
  │ if sslmode requires TLS:    │
  │   hop 2: TCP connect        │ ──► ┌─ Postgres ─┐
  │   hop 3: SSLRequest         │ ──► │            │
  │   hop 4: TLS handshake      │ ◄─► │  cert +    │
  │   hop 5: encrypted pg-wire  │ ◄─► │  key exch  │
  └─────────────────────────────┘     └────────────┘
   buffr sees none of hops 2–5; it only supplied the URL
```

The pg-wire TLS upgrade is STARTTLS-style: the connection opens in plaintext, the
driver sends an `SSLRequest` packet, and *then* the channel upgrades to TLS before
auth credentials cross. That's why the password in `DATABASE_URL` is only as safe
as the `sslmode` that precedes it — under `disable`, the password crosses in
cleartext.

**The model path has no TLS.** `ollamaHost` is `http://localhost:11434`
(`src/config.ts:14`) — plain HTTP. There's no `https://`, no cert. That's
defensible *because* it's loopback: the bytes never leave the machine, so there's
no channel for an attacker to sit on and nothing remote to authenticate. The
moment Ollama moved off-box, this plaintext path would become a real exposure —
but today it's `not yet exercised` as a risk.

### Move 2.5 — current vs future

Phase A (now): TLS policy is whatever `sslmode` says, invisible to code; the
model path is plaintext loopback. For a single-device local DB, `sslmode=disable`
or no TLS is *fine* — nothing's on the wire to intercept.

Phase B (remote DB): `sslmode=verify-full` becomes mandatory, and buffr would
likely need to ship a CA path. What *doesn't* change: `src/db.ts` stays one line —
the new policy rides entirely in the credential. That's the payoff of pushing TLS
into the connection string: the code is already remote-ready.

### Move 3 — the principle

Pushing transport security into the credential (`sslmode`) instead of code means
one binary adapts from "local plaintext" to "verified remote TLS" by swapping a
secret — no recompile, no code change. The cost: the code can't *enforce* a
minimum. Nothing in buffr stops a deployment from running `sslmode=disable`
against a remote DB. Whether that's acceptable is `study-security`'s call; this
guide's job is to name precisely where the decision lives.

## Primary diagram

```
  buffr TLS — recap

  pg-wire (:5432):
    policy = sslmode= inside DATABASE_URL   ── src/db.ts:4
    no ssl/ca/cert code anywhere in the repo
    handshake run entirely by node-postgres
    STARTTLS-style: SSLRequest → upgrade → auth over TLS

  HTTP (:11434):
    http://localhost — NO TLS, plaintext over loopback   ── src/config.ts:14
    defensible while local; a real exposure if Ollama moves off-box

  termination point: Postgres itself (no TLS-terminating proxy in path)
```

## Elaborate

`sslmode` is the libpq-standard way every Postgres client expresses transport
trust, which is why pushing the decision into the URL is idiomatic — the same
string works across psql, drivers, and ORMs. The subtle trap is `sslmode=prefer`
(the historical default in some setups): it *silently downgrades* to plaintext if
the server doesn't offer TLS, giving a false sense of security. For anything
remote, `verify-full` is the only mode that resists an active attacker. buffr,
being local, sidesteps this — but the gradient is the thing to carry to your next
remote-DB system.

## Interview defense

**Q: How does buffr configure TLS for the database?**

```
  DATABASE_URL  ──► ?sslmode=require ──► node-postgres runs TLS
  buffr code: zero TLS lines (src/db.ts:4)
```

Answer: "It doesn't, in code. The whole pg.Pool is `new pg.Pool({
connectionString })` — no `ssl` object. TLS is gated by the `sslmode` parameter
inside `DATABASE_URL`, which node-postgres parses and acts on. The policy lives in
the credential; the code is TLS-agnostic." Anchor: `src/db.ts:4`.

**Q: Is the model server connection encrypted?**

Answer: "No — it's plain `http://localhost:11434` (`src/config.ts:14`). That's
fine because it's loopback; the bytes never leave the machine. It would be a real
exposure only if Ollama moved off-box, which isn't exercised."

**Q: What's the risk of `sslmode` living in the credential rather than code?**

Answer: "The code can't enforce a floor. Nothing stops a deployment from running
`sslmode=disable` — or worse, `prefer`, which silently downgrades to plaintext if
the server doesn't offer TLS. For a remote DB you'd want `verify-full` and ideally
a code-side assertion. Whether that's an acceptable risk is a security-audit
question."

## See also

- `03-tcp-udp-connections-and-sockets.md` — the TCP socket the TLS upgrade rides on
- `02-dns-routing-and-addressing.md` — why a remote host makes `verify-full` urgent
- `study-security` — judging whether the sslmode posture is safe; secrets in `DATABASE_URL`
