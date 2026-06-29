# Parameterized SQL boundary

**Industry name:** parameterized queries / prepared statements (the `$1::vector`
placeholder boundary). *Industry standard.*

## Zoom out, then zoom in

Every byte the operator types, and every chunk the model retrieves, eventually
becomes part of a SQL statement against `reindb`. The question this pattern
answers: does that text ever get *interpreted* as SQL, or only ever treated as a
*value*? Here's where it sits.

```
  Zoom out — the SQL boundary in the stack

  ┌─ Service layer ──────────────────────────────────────────┐
  │  ChatSession / index-cmd / eval-cmd                       │
  │  hold raw strings: the question, the doc text, app_id     │
  └───────────────────────────────┬──────────────────────────┘
                                  │  values passed as an args array
  ┌─ Storage seam ────────────────▼──────────────────────────┐
  │  ★ PgVectorStore.upsert / .search ★   ← THIS PATTERN      │ ← we are here
  │  text + sql template kept SEPARATE: ($sql, [values])      │
  └───────────────────────────────┬──────────────────────────┘
                                  │  node-postgres sends them apart
  ┌─ Postgres ────────────────────▼──────────────────────────┐
  │  parses the template ONCE, binds values as data, not code │
  └───────────────────────────────────────────────────────────┘
```

The pattern (parameterized queries) is the oldest, most boring, most effective
defense against SQL injection there is. The whole idea: the query *template* and
the *values* travel to Postgres on separate channels. The template gets parsed as
code; the values get bound as opaque data. A value can be the entire text of a
malicious markdown file and it still can't change the shape of the query — because
by the time it arrives, parsing is already done.

## The structure pass

**Layers:** the caller holds raw strings → the storage seam (`PgVectorStore`)
builds a `(template, values[])` pair → node-postgres ships them → Postgres parses
template, binds values.

**The axis to trace: trust.** "Is this text treated as code or as data?" Hold
that one question down the layers:

```
  One axis — "code or data?" — traced across the seam

  ┌─ caller ────────────┐   the doc text is just a JS string
  │  could be anything  │   → trust: UNTRUSTED content
  └──────────┬──────────┘
             │  seam: $5 placeholder, value in args[4]
  ┌─ PgVectorStore ─────▼┐  template names a SLOT; value goes in the array
  │  template ≠ value    │  → the flip: text can never be code past here
  └──────────┬───────────┘
             ▼
  ┌─ Postgres ───────────┐  template parsed once; value bound as data
  │  value = pure data    │  → trust: text is INERT
  └───────────────────────┘
```

The trust answer flips exactly at the placeholder. Before the seam the doc text
*could* be SQL; after it, it provably can't be. That's the load-bearing seam — the
contract is "the args array is data, full stop."

## How it works

### Move 1 — the mental model

You already know this shape from any `fetch()` you've written where you build a URL
with `URLSearchParams` instead of `+`-ing strings together — the params get encoded
into their own slot so a `&` in a value can't add a new query param. Same idea, one
layer down: the SQL placeholder is the slot, the args array is the encoded value.

```
  The pattern — two channels, never mixed

  template:  insert ... values ($1, $2, ... $6::vector ...)
                                 │   │        │
  args[]:   [ id, docId, ...,  vector ]       │
                 ▲    ▲          ▲             │
                 └────┴──────────┴── bound as DATA, not parsed
             ──────────────────────────────────────────────
             a ';' or '--' inside any value stays inside that
             value — it never reaches the parser as syntax
```

The kernel: **one template, one args array, a placeholder per value, and the two
sent separately.** Drop any one and you lose the property.

### Move 2 — the walkthrough

**The upsert sink.** This is where indexed-doc and memory text lands. Watch the
template/value split.

```ts
// src/pg-vector-store.ts:47-56  — PgVectorStore.upsert
await client.query(
  `insert into agents.chunks (id, document_id, app_id, chunk_index, content, embedding, embedding_model, meta)
   values ($1, $2, $3, $4, $5, $6::vector, $7, $8)         // ← template: 8 named SLOTS
   on conflict (id) do update set ...`,
  [c.id, docId, this.appId, chunkIndex, content,           // ← values: a JS array
   toVectorLiteral(c.vector), this.embeddingModel, c.meta], //   content can be ANY text
);
```

Line by line: `content` (the `$5` value) is the chunk's text — arbitrary, possibly
hostile markdown. It rides in the args array, never in the template string. Even if
a document literally contained `'); drop table agents.chunks; --`, it lands in the
`content` column as that exact string. The parser already finished with the
template; the value is inert.

**The search sink.** The query path, where the model's tool call reaches the DB.

```ts
// src/pg-vector-store.ts:70-78  — PgVectorStore.search
const { rows } = await this.pool.query(
  `select id, content, chunk_index, document_id, meta,
          1 - (embedding <=> $1::vector) as score
   from agents.chunks
   where app_id = $2                                       // ← tenant filter, parameterized
   order by embedding <=> $1::vector
   limit $3`,
  [toVectorLiteral(vector), this.appId, k],                // ← $1 vector, $2 app_id, $3 k
);
```

`app_id` is `$2` — a value, not interpolated. `k` is `$3`. Even the limit is bound,
not concatenated. (Note: this `app_id` filter is shape-only tenant scoping, not a
security boundary — see `04-shape-only-tenant-isolation.md`. But the *injection*
property is intact regardless.)

**The one serialize-to-text spot — and why it's safe.** The query vector and the
stored vector get turned into a pgvector text literal:

```ts
// src/pg-vector-store.ts:15-17
function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;                               // joins a number[], not text
}
```

This *looks* like string-building, but `v` is a `number[]` the embedder produced —
and `assertDim` (`src/pg-vector-store.ts:32-36`) throws if it's the wrong length
before this runs. No attacker-controlled *string* flows through `join`; only
numbers. The literal then rides as a `$N::vector` value anyway. The two guards —
numbers-only input, plus parameterized placement — close it.

**The other sinks, same shape.** `indexDocumentRow` (`src/runtime.ts:11-16`, `$1`–`$4`),
`persistMessage` (`src/supabase-trace-sink.ts:27-36`, `$1`–`$8`), `startConversation`
(`:5-7`), `loadProfile` (`src/profile.ts:5-6`, `$1`). No exception across the
codebase — every value is bound, never concatenated.

```
  Every sink, audited — the args-array contract

  ┌─ sink ────────────────────┬─ user/model text in it ─┬─ how bound ─┐
  │ upsert       (pg-vs:47)   │ content ($5)            │ $1..$8       │
  │ search       (pg-vs:70)   │ app_id ($2)             │ $1..$3       │
  │ indexDocumentRow (rt:11)  │ content ($4)            │ $1..$4       │
  │ persistMessage  (sts:27)  │ content ($3)            │ $1..$8       │
  │ loadProfile  (prof:5)     │ app_id ($1)             │ $1           │
  └───────────────────────────┴─────────────────────────┴─────────────┘
  one exception: migrate.ts runs a dev-authored .sql file whole — not user input
```

### Move 3 — the principle

Parameterization isn't a feature you turn on; it's a discipline of never letting
untrusted text and query structure share a string. The win is *categorical*: it's
not "harder to inject," it's "the value can't be parsed as code, ever." That
all-or-nothing quality is why a tiny, boring control out-defends any amount of
input-scrubbing — you're not filtering bad input, you're removing the channel
through which input could ever become code.

## Primary diagram

```
  The parameterized SQL boundary — full picture

  ┌─ Service layer ──────────────────────────────────────────┐
  │  question / doc text / app_id   (UNTRUSTED strings)       │
  └───────────────────────────────┬──────────────────────────┘
                                  │  call(template, [values])
  ┌─ Storage seam: PgVectorStore ─▼──────────────────────────┐
  │  template:  ... ($1, $2, $6::vector, ...)   ← parsed as code
  │  args[]:    [ id, app_id, ..., vector ]      ← bound as data
  │  guard:     assertDim() before toVectorLiteral (numbers only)
  └───────────────────────────────┬──────────────────────────┘
                                  │  node-postgres: two channels
  ┌─ Postgres (reindb.agents) ────▼──────────────────────────┐
  │  parse template ONCE → bind values → execute             │
  │  a ';' in a value is data, never syntax                  │
  └───────────────────────────────────────────────────────────┘
```

## Elaborate

SQL injection is the textbook trust-boundary failure: text crossing from a place
you don't control (a request body, a file, a model's output) into a place that
interprets it (the query parser). The fix predates most current frameworks —
prepared statements have been the answer since the 90s — and it's still #1 because
the failure is still everywhere. The reason buffr gets it free is that
`PgVectorStore` was built against aptkit's `VectorStore` contract from day one with
the args-array convention, so there was never a string-built query to retrofit.

For the next phase: parameterization defends *injection*, but it does nothing for
*authorization* — `app_id = $2` is bound safely, yet it's not a security boundary
(no RLS enforces it). The two controls are orthogonal. See
`04-shape-only-tenant-isolation.md` for the half this pattern doesn't cover.

## Interview defense

**Q: Your store concatenates the vector into a text literal — isn't that a SQL
injection risk?**
The load-bearing detail people miss: it joins a `number[]`, not a string, and
`assertDim` throws on bad length first, *and* the literal still rides as a
`$N::vector` parameter. Three things would all have to fail. No attacker-controlled
text reaches `join`.

```
  what an interviewer expects you to spot
  toVectorLiteral(v)  →  v is number[]   (not string)
       │                 assertDim() guards length
       ▼
  placed as $6::vector  →  bound as data anyway
  → injection needs a STRING channel; there isn't one
```

**Q: Where's the one place this could break?**
`migrate.ts:13` runs a whole `.sql` file as one statement. That's safe only because
the file is developer-authored and its path is hardcoded
(`src/migrate.ts:28`). If a filename or its contents ever came from outside, that's
the spot to harden.

**Anchor:** "Template and values travel on separate channels — a `;` in a value is
data, never syntax."

## See also

- `audit.md` lens 3 — input-validation-and-injection, full sink inventory.
- `04-shape-only-tenant-isolation.md` — why `app_id = $2` is bound but not enforced.
- `.aipe/study-data-modeling/` — the `agents.chunks` schema these queries write.
