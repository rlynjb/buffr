# 04 · TLS and Trust Establishment

> Encryption in transit — one boundary gated by a credential, one plaintext by design, six now default-verified HTTPS — Industry standard
> · `sslmode` for Postgres, no TLS for loopback Ollama, platform defaults for every connector

## Zoom out, then zoom in

The verdict used to be one line — "buffr has zero TLS code" — and that's still
technically true, but it now undersells the picture. There are three TLS
stories in this repo, not one: pg-wire encryption is still decided entirely by
`sslmode` inside `DATABASE_URL`; the model path is still plain HTTP over
loopback, no TLS at all; and — new since the last pass — the six connectors in
`@buffr/connectors` all speak real HTTPS to real remote hosts, with real
certificate verification, using nothing but the platform default (no explicit
TLS code there either, but for a different reason: Node's `fetch` verifies
certs unless you go out of your way to turn that off, and nothing in this repo
does). So "trust establishment" is still a config-and-defaults story, not a
code story — but it now spans three boundaries with three different answers.

```
  Zoom out — TLS is decided in the credential, or left at the platform default

  ┌─ Config / connector layer ────────────────────────────────────────────┐
  │  DATABASE_URL  ──►  postgres://…?sslmode=require                      │
  │                              ▲                                        │
  │                    ★ TLS policy lives HERE for pg-wire ★              │
  │  connector fetch() calls  ──►  https://reddit.com, …  (no TLS code)  │
  │                              ▲                                        │
  │                    ★ TLS policy is the PLATFORM DEFAULT here ★        │
  └───────┬──────────────────────────────┬────────────────────┬──────────┘
          │ pg-wire: TLS iff sslmode says │ HTTP: plaintext    │ HTTPS: default-verified
          ▼                               ▼                    ▼
   [ Postgres ]                    [ Ollama on localhost ]  [ Reddit / Google / Brave /
   STARTTLS-style, per sslmode     no TLS (loopback)         Tavily / Amazon / Trends ]
                                                              cert chain + hostname checked
```

Zoom in: TLS establishes two things — that the bytes are encrypted, and that the
peer is who it claims (certificate verification). buffr dials that in three
different ways across three boundaries: explicitly via a credential parameter
(Postgres), explicitly by omission (Ollama, loopback), and implicitly via
"don't override the platform default" (every connector).

## Structure pass

**Layers.** Credential / connector code → Driver or fetch implementation
(node-postgres reads `sslmode`; Node's `fetch` applies its built-in cert
verification) → TLS handshake (if enabled) → encrypted wire. buffr touches
only the top layer on every boundary; the actual handshake is always someone
else's code (node-postgres, or Node's own `fetch`/undici).

**Axis — trace `trust` across all three boundaries.**

```
  axis = "is the peer authenticated and the channel encrypted?"

  ┌─ pg-wire boundary ─────────┐  seam  ┌─ HTTP boundary ────┐  seam  ┌─ connector boundary ──────┐
  │ depends on sslmode:         │ ═════► │ NO TLS              │ ═════► │ HTTPS, default-verified    │
  │  disable → none             │ (flips)│ plaintext over      │ (flips)│ cert chain + hostname check│
  │  require → encrypted        │        │ loopback            │        │ (Node fetch default;       │
  │  verify-full → + cert check │        │ (no peer to verify) │        │  no override anywhere)     │
  └──────────────────────────────┘        └──────────────────────┘        └──────────────────────────────┘
   explicit, per-deployment               explicit, by design            implicit, platform-default
   (buffr holds the knob)                 (no knob needed — loopback)    (buffr never touches the knob)
```

**Seam.** Two load-bearing seams now. `sslmode` is still the knob where the
pg-wire trust axis flips from "plaintext" to "encrypted" to "encrypted +
verified" — and it's a secret, not source, so the same binary behaves
differently per deployment. The new seam is the connector boundary: trust
there isn't a knob at all — it's "whatever `fetch` does when nobody
configures anything," which happens to be the *strongest* of the three
postures (verified cert chain, verified hostname) purely because nobody wrote
code to weaken it.

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

**The connectors get real TLS for free, and it's worth being precise about why.**
Every connector's URL is built with `https://` — Reddit's `search.json`,
Google Custom Search, Brave, Tavily, Amazon, and (inside `google-trends-api`)
the trends endpoint. None of the six connector files, and nothing in
`src/session.ts`, constructs a custom `https.Agent`, sets
`rejectUnauthorized: false`, or touches `NODE_TLS_REJECT_UNAUTHORIZED`. That
means every one of these requests gets Node's built-in TLS behavior: the
system CA store validates the certificate chain, and the hostname in the URL
is checked against the certificate's subject — the equivalent of Postgres's
`verify-full`, the *strongest* rung on the `sslmode` ladder from Move 1, and
buffr gets it by writing zero TLS code rather than by choosing it explicitly.

```
  Pattern — three ways to end up with (or without) verified TLS

   pg-wire:      sslmode=verify-full   ── explicit opt-in, in a credential
   Ollama:        http://               ── explicit opt-out, by using http://
   connectors:    https:// + no override ── implicit opt-in, by doing nothing
```

The contrast matters for how you reason about risk: the pg-wire and Ollama
postures are *decisions* (even if the decision is "loopback needs none"); the
connector posture is an *absence of a decision* that happens to land on the
safe side because Node's default is safe. If a future connector ever needed a
custom CA, a self-signed dev endpoint, or a proxy that MITMs TLS for caching,
someone would have to explicitly weaken this — and that line doesn't exist yet
to weaken.

### Move 2.5 — current vs future

Phase A (now): TLS policy for pg-wire is whatever `sslmode` says, invisible to
code; the model path is plaintext loopback; the connector path is
default-verified HTTPS with zero configuration. For a single-device local DB,
`sslmode=disable` or no TLS on the model path is *fine* — nothing's on the
wire to intercept. The connectors are already at the safe default because they
reach the open internet by construction.

Phase B (remote DB): `sslmode=verify-full` becomes mandatory, and buffr would
likely need to ship a CA path. What *doesn't* change: `src/db.ts` stays one line —
the new policy rides entirely in the credential. That's the payoff of pushing TLS
into the connection string: the code is already remote-ready. The connector
path needs no Phase B at all — it was already reaching remote, untrusted hosts
from day one of the connector's existence.

### Move 3 — the principle

Pushing transport security into the credential (`sslmode`) instead of code means
one binary adapts from "local plaintext" to "verified remote TLS" by swapping a
secret — no recompile, no code change. The cost: the code can't *enforce* a
minimum. Nothing in buffr stops a deployment from running `sslmode=disable`
against a remote DB. The connectors show the other side of the same coin: not
writing TLS code *also* means not being able to accidentally weaken it — the
platform default is the floor and the ceiling. Whether the pg-wire gap is
acceptable is `study-security`'s call; this guide's job is to name precisely
where each boundary's decision lives, and for the connectors, to name that
there effectively isn't one to make yet.

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

  connectors (:443 × up to 6):
    https:// hardcoded in every connector URL (RSS: caller-supplied)
    no custom Agent, no rejectUnauthorized override, anywhere in the repo
    → Node/undici default: cert chain + hostname verified (verify-full-equivalent)
    handshake run entirely by Node's fetch implementation

  termination point: Postgres itself (pg-wire); each provider's own edge (connectors)
```

## Elaborate

`sslmode` is the libpq-standard way every Postgres client expresses transport
trust, which is why pushing the decision into the URL is idiomatic — the same
string works across psql, drivers, and ORMs. The subtle trap is `sslmode=prefer`
(the historical default in some setups): it *silently downgrades* to plaintext if
the server doesn't offer TLS, giving a false sense of security. For anything
remote, `verify-full` is the only mode that resists an active attacker. buffr,
being local on the DB side, sidesteps this — but the gradient is the thing to
carry to your next remote-DB system. The connectors are the opposite lesson:
sometimes the safest TLS configuration is the one nobody wrote code for. Fetch
implementations that default to verified TLS (Node's `fetch`, browser `fetch`,
most modern HTTP clients) mean a codebase can reach dozens of third-party APIs
without a single line of transport-security code and still land on the strong
end of the trust gradient — right up until someone adds a debugging override
and forgets to remove it.

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

**Q: What about the connectors — Reddit, Google, Brave, Tavily, Amazon, Trends?**

Answer: "Real HTTPS, real verification, zero configuration. Every connector
builds an `https://` URL and calls `fetch` — nothing in the repo overrides
Node's default TLS behavior, so every request gets full certificate-chain and
hostname verification. It's the strongest posture of the three boundaries in
this repo, and buffr got there by not writing any TLS code at all — the
platform default already lands on 'verified.'" Anchor:
`packages/connectors/src/discovery/*.ts` — no `Agent`, no
`rejectUnauthorized`, anywhere.

**Q: What's the risk of `sslmode` living in the credential rather than code?**

Answer: "The code can't enforce a floor. Nothing stops a deployment from running
`sslmode=disable` — or worse, `prefer`, which silently downgrades to plaintext if
the server doesn't offer TLS. For a remote DB you'd want `verify-full` and ideally
a code-side assertion. Whether that's an acceptable risk is a security-audit
question. Contrast that with the connector boundary, where there's no knob to
misconfigure in the first place."

## See also

- `03-tcp-udp-connections-and-sockets.md` — the TCP socket the TLS upgrade rides on
- `02-dns-routing-and-addressing.md` — why a remote host makes `verify-full` urgent, and the six connector hostnames
- `05-http-semantics-caching-and-cors.md` — what rides on top of the connectors' TLS once the channel is open
- `study-security` — judging whether the sslmode posture is safe; secrets in `DATABASE_URL`
