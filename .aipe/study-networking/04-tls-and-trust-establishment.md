# TLS & Trust Establishment — encryption in transit

**Transport-layer security & termination** · Industry standard

## Zoom out, then zoom in

Two wires, two completely different answers to "is this encrypted?" The
Postgres wire *can* and usually *should* be TLS — but buffr configures that
entirely through a string, not code. The Ollama wire is plaintext HTTP, and
that's the *correct* call because it's loopback. The interesting thing here is
how little code there is: buffr's TLS posture is almost entirely a substring of
`DATABASE_URL`.

```
  Zoom out — where encryption lives (and doesn't)

  ┌─ Provider layer ────────────────────────────────────────────────┐
  │   Postgres :5432                       Ollama :11434             │
  └──────┬──────────────────────────────────────┬──────────────────┘
         │ TLS? depends on DATABASE_URL          │ plaintext (loopback)
  ┌─ Trust / encryption ────────────────────────────────────────────┐
  │   sslmode in the conn string            none — and that's right  │ ★ THIS FILE ★
  │   (no `ssl:` on the Pool object)        no cert, no handshake     │
  └──────┬──────────────────────────────────────┬──────────────────┘
         │                                       │
  ┌─ Service layer ─────────────────────────────────────────────────┐
  │   createPool(connectionString)          fetch('http://...')      │
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in: TLS answers "*can anyone on the path read or tamper with these
bytes?*" The path is the whole story. The DB wire crosses the public internet —
someone is on the path, so it needs encryption. The Ollama wire is `127.0.0.1`
— *no one* is on the path, so encryption buys nothing.

## Structure pass

**Layers.** App → connection config → TLS handshake → TCP. Trace *trust* down.

**Axis — "who can read these bytes on the wire?"**

```
  One question across the two wires

  "who can read the bytes in flight?"

  ┌─ Ollama wire (http, loopback) ──────────┐
  │  only processes ON THIS MACHINE          │  → no path attacker exists
  └──────────────────────────────────────────┘
           ║  the trust seam: on-box vs internet
  ┌─ Postgres wire (remote) ────────────────┐
  │  anyone on the network path BETWEEN you  │  → needs TLS or creds + data
  │  and Supabase                            │     are readable in transit
  └──────────────────────────────────────────┘
```

**Seam.** The seam is loopback vs internet again (same boundary as `02`), but
now traced on the *trust* axis. On one side, no encryption is needed and the
repo correctly provides none. On the other, encryption is needed and the repo
delegates the decision to a config string it never inspects.

## How it works

### Move 1 — the mental model

TLS is a handshake that does two jobs before any real data flows: prove the
server is who it claims (certificate), and agree on a shared secret to encrypt
everything after (key exchange). You've seen the shape — it's the `https://`
padlock — but the key insight for buffr is *where it terminates*: the encryption
ends at whatever endpoint holds the cert.

```
  The TLS handshake kernel

  client                          server
    │  ClientHello (ciphers)  ─────►│
    │◄───── ServerHello + cert ─────│   client verifies cert against CA
    │  key exchange ───────────────►│
    │◄──── encrypted from here ─────►│   all app bytes now encrypted
    │                               │
  termination = the endpoint with the cert. for buffr's DB that's
  Supabase's Postgres (or its TLS-terminating proxy).
```

### Move 2 — the two trust paths

**Postgres — TLS configured by string, not code.** buffr builds the Pool with
*only* `connectionString` (`src/db.ts:5`). It never sets the `ssl` option on the
Pool object. So whether TLS happens depends entirely on what's inside
`DATABASE_URL` — specifically an `sslmode=...` query parameter, which
node-postgres parses out of the URL.

```
  Layers-and-hops — where the TLS decision is made

  ┌─ buffr ──────────────┐   passes whole string   ┌─ node-postgres ─┐
  │ createPool(connStr)  │ ──────────────────────► │ parse sslmode   │
  │ (no ssl: option)     │                         │ from the URL    │
  └──────────────────────┘                         └────────┬────────┘
                                                    sslmode  │
                                            ┌───────────────┴────────────┐
                                       require/verify-full         disable
                                       ┌──────────────┐         ┌──────────┐
                                       │ TLS handshake│         │ plaintext│
                                       │ to Supabase  │         │ over net │
                                       └──────────────┘         └──────────┘

  buffr never sees this branch — it's resolved from a string it doesn't read
```

The consequence, stated plainly: if `DATABASE_URL` lacks an `sslmode` (or sets
`disable`), the password and every row cross the public internet in cleartext,
and *nothing in buffr's code would catch that*. The `.env.example` documents the
format `postgres://USER:PASSWORD@HOST:PORT/reindb` but doesn't pin `sslmode` —
so the TLS posture is an operator responsibility, not a code guarantee. That's a
real finding for `study-security` to own; this file's job is to show *that the
decision lives in the string*.

**Ollama — plaintext, correctly.** aptkit's transport `fetch`es
`http://localhost:11434/api/chat` — `http`, not `https`. No cert, no handshake.
This is right: the bytes never leave the machine (`02`), so there's no path
attacker to encrypt against. Adding TLS here would be cost with zero benefit —
a self-signed cert on loopback protects against an attacker who, by definition,
isn't there.

```
  Ollama — no TLS, and that's the correct call

  ┌─ buffr ─┐  http:// (plaintext)  ┌─ Ollama ─┐
  │ fetch   │ ────────────────────► │ :11434   │
  └─────────┘   over kernel loopback└──────────┘
              no NIC ⇒ no eavesdropper ⇒ no TLS needed
```

### Move 2.5 — current vs future

Today the only TLS in the system is whatever Supabase requires, configured via
the connection string. If a future phase moves Ollama off-box (the model server
on another machine), the `http://` becomes a liability — that wire would then
cross a network and need `https://` plus a cert. The migration cost is small (a
scheme change in `OLLAMA_HOST`) but the *security* implication is large, and
today's plaintext default would silently carry over. Worth flagging now.

### Move 3 — the principle

TLS is about the *path*, not the protocol. The same `http`-vs-`https` choice is
correct or catastrophic depending solely on whether the bytes traverse a
network you don't control. buffr gets both calls right *by circumstance* — DB
remote (TLS via string), Ollama local (plaintext) — but the DB side is right
only if the operator sets `sslmode`. The lesson: when encryption is configured
by string rather than code, your code can't enforce it, so the guarantee is
only as strong as your deployment discipline.

## Primary diagram

Both wires, trust posture side by side, with where the decision is made.

```
  buffr's TLS posture — both wires

  Postgres wire (remote)                 Ollama wire (loopback)
  ┌─────────────────────────────┐        ┌────────────────────────────┐
  │ encryption: IF sslmode set   │        │ encryption: none           │
  │ decided by: DATABASE_URL str │        │ decided by: http:// scheme │
  │ terminates at: Supabase      │        │ no termination (plaintext) │
  │ code that enforces it: NONE  │        │ correct? YES (no path attkr)│
  │ src/db.ts:5 (no ssl: option) │        │ src/config.ts:14           │
  └─────────────────────────────┘        └────────────────────────────┘
```

## Implementation in codebase

**Use cases.** TLS is reached for implicitly on every DB connection *if* the
connection string asks for it. There is no explicit TLS code, no cert loading,
no `ssl: { ... }` block anywhere in the repo. Cadence note: because `chat` holds
one warm pool across the whole session, the TLS handshake (like the TCP one) is
paid once on the first connection and amortized over every later turn — the
cost lives at session start, not per query.

**Code side by side.** The absence is the finding:

```
  src/db.ts  (lines 4–6)

  return new pg.Pool({ connectionString: databaseUrl });
                       │
                       └─ no `ssl:` key. so TLS is whatever `sslmode` says
                          inside the URL. buffr asserts nothing about
                          encryption — it can't, this is the only config it sets.
```

```
  .env.example  (DATABASE_URL line)

  # Format: postgres://USER:PASSWORD@HOST:PORT/reindb
                                              │
                                              └─ no sslmode shown. the example
                                                 doesn't pin encryption, so a
                                                 copy-paste deploy might run
                                                 plaintext to a remote host.
```

## Elaborate

TLS terminates wherever the cert lives. With managed Postgres like Supabase,
that's typically a TLS-terminating proxy in front of the database, not the DB
process itself — which is why `sslmode=verify-full` (check the cert chain *and*
the hostname) is stronger than `require` (encrypt but don't verify identity).
buffr does neither in code; it inherits whatever the operator wrote. The deeper
point connects to `study-security`: encryption-in-transit is one of three
properties (also at-rest, and access control) and the only one visible at the
network layer. The other two live in that guide.

## Interview defense

**Q: Is your database connection encrypted?**

```
  DATABASE_URL ──contains sslmode?──► node-postgres ──► TLS or plaintext
       │                                                      │
       └─ buffr sets no ssl: option ─────────────────────────┘
          so the answer is "whatever the string says"
```

Answer — honest: "It depends on `DATABASE_URL`. I pass only the connection
string to `pg.Pool` and set no `ssl` option, so encryption rides on the
`sslmode` parameter. With Supabase that's effectively required, but my code
doesn't enforce it — if someone deployed with `sslmode=disable`, credentials
would cross the internet in cleartext and nothing in the repo would stop it."
Anchor: `src/db.ts:5`.

**Q: Why is Ollama plain HTTP — isn't that insecure?**

Answer: "No, it's correct. Ollama is on `localhost:11434`, so the bytes never
leave the machine via loopback — there's no path attacker to encrypt against.
TLS there would be pure overhead. It'd only become a problem if the model server
moved off-box, at which point the `http://` scheme would need to become
`https://`." Anchor: `src/config.ts:14`.

## Validate

1. **Reconstruct:** the TLS handshake kernel — cert verify + key exchange before
   app data.
2. **Explain:** why does buffr's *code* not guarantee DB encryption? (no `ssl:`
   option; it's a string parameter — `src/db.ts:5`.)
3. **Apply:** operator sets `sslmode=disable` to a remote host. What's exposed
   and where would buffr catch it? (password + rows in cleartext; buffr catches
   nothing.)
4. **Defend:** justify plaintext for Ollama. (loopback, no path attacker —
   `src/config.ts:14`.)

## See also

- `02-dns-routing-and-addressing.md` — the loopback-vs-internet path this trust
  posture rides on.
- `03-tcp-udp-connections-and-sockets.md` — TLS sits between TCP and the app data.
- `study-security` — credential handling and the full trust-boundary analysis.

Updated: 2026-06-24 — Re-verified the TLS-by-string finding against current `src/` (still `src/db.ts:5`, no `ssl:` option, no explicit TLS code) and added the warm-session cadence note: under `chat` the TLS handshake is paid once on the session pool's first connection and amortized across every turn. No stale `ask-cmd` refs in this file.
