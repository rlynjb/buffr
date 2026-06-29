# Parameterized SQL boundary

**Industry name(s):** parameterized queries / prepared statements /
bound parameters. **Type:** Industry standard.

## Zoom out, then zoom in

Every byte that travels from your laptop to `reindb` crosses one
boundary, and at that boundary there's exactly one rule that keeps an
attacker's text from becoming an attacker's *query*: the value never
touches the SQL string. It rides in a separate slot.

```
  Zoom out — where the SQL boundary lives

  ┌─ UI (Ink TUI) ───────────────────────────────────┐
  │  src/cli/chat.tsx  — you type a question          │
  └───────────────────────────┬──────────────────────┘
                              │ in-process
  ┌─ Service (session/agent) ─▼──────────────────────┐
  │  ★ PgVectorStore / runtime / profile / sink ★    │ ← we are here
  │     build SQL with $1,$2,...  +  values array     │
  └───────────────────────────┬──────────────────────┘
                              │ DATABASE_URL → TLS
  ┌─ Storage (Postgres) ──────▼──────────────────────┐
  │  pg parses SQL ONCE, binds values into slots      │
  │  agents.chunks / documents / messages / profiles  │
  └───────────────────────────────────────────────────┘
```

Zoom in: the pattern is *separate the code from the data*. The query
text — with `$1`, `$2`, `$1::vector` placeholders — is parsed by
Postgres on its own. The values arrive as a second argument, an array,
and get *bound* into the parsed plan's slots. A value can never be
re-interpreted as SQL syntax because by the time the value shows up,
the parser has already finished. This is the control that makes
buffr's database boundary injection-resistant. The interesting part in
this repo isn't that it's used — it's the one place that *looks* like
string-building and isn't.

## The structure pass

**Layers:** the SQL boundary appears at four sites, all at the same
altitude (the storage-adjacent service layer): `PgVectorStore`
(`src/pg-vector-store.ts`), `runtime` (`src/runtime.ts`), `profile`
(`src/profile.ts`), `trace-sink` (`src/supabase-trace-sink.ts`).

**Axis — trust.** Trace "is this string trusted as code?" across the
boundary:

```
  axis traced = "can this text become SQL syntax?"

  ┌─ app side ──────┐   seam: pg.query(text, values)   ┌─ Postgres ──┐
  │ values UNtrusted│ ═════════════╪═══════════════════►│ values are  │
  │ (could be evil) │   (it flips)                      │ DATA only   │
  └─────────────────┘                                   └─────────────┘
           ▲                                                   ▲
           └──────── same text, two roles ─────────────────────┘
             app: "might be hostile"   pg: "bound, inert"
```

**Seam:** the `pool.query(text, valuesArray)` call. That's where the
trust answer flips — left of it a value is suspect, right of it it's
inert data bound into a pre-parsed plan. The whole defense is that
this seam is *always* used and the value array is *always* the second
argument. Now the mechanics.

## How it works

You already know this shape from frontend work: a React `key` is a
slot the framework fills, not a string you concatenate into markup.
Same idea — `$1` is a slot Postgres fills, not a string you splice into
SQL.

```
  The pattern — two channels, never mixed

   SQL text (parsed first)        values (bound second)
   ┌──────────────────────────┐   ┌────────────────────┐
   │ insert ... values        │   │ [ c.id,            │
   │   ($1,$2,$3,$4,$5,        │ + │   docId, appId,    │
   │    $6::vector,$7,$8)      │   │   ... vectorText ] │
   └──────────────────────────┘   └────────────────────┘
        │  parser runs on THIS            │
        ▼  (no values present yet)        ▼
   plan with 8 empty slots  ──────►  slots filled, inert
```

### The kernel — what breaks if it's missing

Strip the value array and inline the values into the string, and the
whole control collapses: a chunk whose text is
`'); drop table agents.chunks; --` would become executable SQL. The
load-bearing part is the *separation* — `text` with placeholders, plus
a `values` array, passed as two arguments to one `query` call. Lose
the second argument and you've lost the boundary.

### The upsert sink — read it line by line

The chunk upsert is the highest-traffic sink and the one that carries
model-adjacent data. Here's the real code (`src/pg-vector-store.ts:47`):

```
  await client.query(
    `insert into agents.chunks (id, document_id, app_id, chunk_index,
        content, embedding, embedding_model, meta)
     values ($1, $2, $3, $4, $5, $6::vector, $7, $8)   ◄ 8 slots, no values inline
     on conflict (id) do update set ...`,
    [c.id, docId, this.appId, chunkIndex,             ◄ values array — the 2nd arg
     content, toVectorLiteral(c.vector),              ◄ vector as text, but BOUND
     this.embeddingModel, c.meta],
  );
```

- `$1..$8` are slots; the SQL string contains no data, only structure.
- `$6::vector` — the placeholder gets a cast. pg binds the *value* of
  `$6` then casts the bound value to `vector`. The cast is part of the
  parsed query, not the data.
- The values array is the second argument. `c.id`, `content`, `c.meta`
  — all of which may contain model- or document-derived text — go in
  here, inert.

### The trap that looks like a hole (and isn't)

This is the one place worth slowing down on. `toVectorLiteral`
builds a string by concatenation (`src/pg-vector-store.ts:15`):

```
  function toVectorLiteral(v: number[]): string {
    return `[${v.join(',')}]`;     ◄ string-building! red flag at first glance
  }
```

Then `search` uses it (`src/pg-vector-store.ts:70`):

```
  `... 1 - (embedding <=> $1::vector) as score
   from agents.chunks
   where app_id = $2
   order by embedding <=> $1::vector
   limit $3`,
  [toVectorLiteral(vector), this.appId, k],   ◄ the literal is $1 — BOUND, not spliced
```

Walk the boundary condition: is this injectable? No — and naming *why*
is the lesson. The string `[0.1,0.2,...]` is **passed as `$1`**, a
bound parameter, not concatenated into the query body. So even though
buffr built a string, that string crosses the seam as data. Two
reasons it's safe, in order of strength: (1) it's bound, so it can't be
syntax regardless of content; (2) belt-and-suspenders, its content is
`number.join(',')` from the embedder — there's no path for free text to
reach it. The first reason is the one that matters; the second is why
you'd sleep fine even if the first were ever weakened.

### Memory adds no new sink

Worth confirming because it's a recent change. Conversation memory
writes through `@aptkit/memory`, which calls `store.upsert(...)`
(`src/session.ts:53`) — the *same* `PgVectorStore.upsert` above. There
is no second SQL path for memory. It inherits this boundary wholesale.
The session and trace layers add inserts (`src/supabase-trace-sink.ts:27`,
`:5`) but all of them are parameterized the same way. Grep the repo for
SQL and you'll find no string-built query anywhere.

### The principle

The control isn't "validate the input" — it's "make the input
*structurally incapable* of being code." Parameterization wins over
sanitization because sanitization is a blocklist you can be wrong about
and binding is an architecture that can't be wrong. The generalizable
move: when untrusted data meets an interpreter (SQL, shell, a template
engine, `dangerouslySetInnerHTML`), the durable fix is a separate
channel for data, not a cleverer escape function.

## Primary diagram

The full boundary, all four sinks, one rule.

```
  Parameterized SQL boundary — buffr-laptop

  ┌─ Service layer (app process) ───────────────────────────────────┐
  │  pg-vector-store.upsert   insert chunks   ($1..$8, $6::vector)   │
  │  pg-vector-store.search   knn select      ($1::vector,$2,$3)     │
  │  runtime.indexDocumentRow insert documents($1..$4)              │
  │  profile.loadProfile      select content  ($1)                  │
  │  trace-sink.persistMessage insert messages($1..$8)             │
  │  memory.remember ─────────► reuses upsert (no new SQL)          │
  └───────────────────────────┬─────────────────────────────────────┘
            text + values[]    │   pool.query(text, values)
                              ▼   ── the seam: data never in `text`
  ┌─ Storage layer (Postgres) ──────────────────────────────────────┐
  │  parse SQL once  →  bind values into slots  →  execute           │
  │  bound values are DATA — never re-parsed as syntax               │
  └──────────────────────────────────────────────────────────────────┘
```

## Elaborate

Prepared statements date to the era when SQL injection topped the OWASP
list — the fix that finally worked wasn't better escaping, it was
moving the value out of the parsed string entirely. node-postgres
(`pg`) implements this with the extended query protocol: `Parse` (the
text, once) then `Bind` (the values) are distinct protocol messages.
buffr never sees that wire detail — it just always passes a values
array. The discipline that keeps this safe is boring on purpose:
*never* build a query by template string with a value in it. The
moment one sink breaks that rule, the boundary has a hole the size of
that one query.

This connects to the data layer: the *shape* of these tables (what
columns, what types, the soft-link FK) is a data-modeling concern; the
fact that writes to them can't be hijacked is this security concern.
The same `pool.query` calls show up in both guides under different
lenses.

## Interview defense

**Q: Your `search` builds a vector string by hand with `.join(',')`.
Isn't that SQL injection?**

No — and the reason is the load-bearing one. The string is passed as
a *bound parameter* (`$1::vector`), not concatenated into the query
body. Binding means the parser already ran before the value arrived,
so the value can't become syntax no matter what it contains. The
content also happens to be machine-generated floats from the embedder,
but I don't rely on that — the binding is the defense, the source is
the backup.

```
  build string  ─►  pass as $1  ─►  pg binds it  ─►  inert
   (looks scary)     (the seam)     (parsed already)  (safe)
```

Anchor: *the string is data because it's bound, not because it's clean.*

**Q: Where would this break?**

The day someone adds a query with a value template-spliced into the
text instead of bound — e.g. `where app_id = '${appId}'`. The fix
isn't to escape `appId`, it's to make it `$1` and pass it in the values
array. The control is architectural, so the failure mode is
architectural: one sink that doesn't use it.

Anchor: *one inline value reopens the whole boundary.*

## See also

- `audit.md` — lens 3 (input-validation-and-injection), the full sink
  list.
- `02-shape-only-tenant-isolation.md` — the `app_id = $2` filter these
  queries carry, and why that filter is *isolation by convention*, not
  enforcement.
- `../study-data-modeling/` — the *shape* of `agents.chunks` /
  `documents` / `messages` these queries write to.
- `../study-database-systems/` — how Postgres parses-then-binds at the
  storage engine level.
