# Parameterized SQL Boundary

*Prepared statements / bound parameters — Industry standard.*

## Zoom out, then zoom in

Here's the whole data path, with the one boundary this file is about marked.

```
  Zoom out — where the SQL boundary sits

  ┌─ CLI layer ─────────────────────────────────────────────┐
  │  argv "question"   ·   *.md file text   ·   embeddings   │  untrusted-ish
  └─────────────────────────┬───────────────────────────────┘
                            │  JS values (strings, number[])
  ┌─ Storage adapter ──────▼────────────────────────────────┐
  │  PgVectorStore · runtime · profile · trace-sink          │
  │  ★ every query: SQL text + bound params, kept apart ★    │ ← we are here
  └─────────────────────────┬───────────────────────────────┘
                            │  wire protocol: query + param array
  ┌─ Postgres (reindb) ────▼────────────────────────────────┐
  │  parser sees fixed SQL; params arrive as typed values    │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: the question is the oldest one in the book — *does any value the
program didn't write itself ever become part of the SQL text the database
parses?* If yes, that value can change the *structure* of the query (add a
`; DROP`, a `UNION`, an `OR 1=1`) and you have injection. If the value only
ever arrives as a **bound parameter**, the database has already finished
parsing the structure before it sees the value, and the worst a hostile
string can do is be a weird value in a `WHERE`. buffr does the second thing,
everywhere. That's the pattern.

## Structure pass

**Layers.** Two: the SQL *text* (the structure — `select`, `from`, `where`,
the `$N` placeholders) and the *parameter array* (the values). They travel
to Postgres separately.

**Axis — trust.** Trace "is this attacker-controllable?" down the two
layers:

```
  One axis (trust) across the two layers of a query

  ┌─ SQL text layer ──────────────────────────────┐
  │  "select ... where app_id = $2 limit $3"       │  → repo-authored,
  │                                                │     NEVER from input
  └────────────────────────────────────────────────┘
  ┌─ parameter layer ─────────────────────────────┐
  │  [vectorLiteral, appId, k]                     │  → may contain input,
  │                                                │     but only as VALUES
  └────────────────────────────────────────────────┘

  the trust answer flips across the layers — and the boundary
  between them is exactly what makes injection impossible
```

**Seam.** The load-bearing seam is the `pool.query(text, params)` call
itself. On one side, fixed structure the parser trusts; on the other, values
the parser never lets touch structure. The seam holds because node-postgres
sends them as two distinct fields of the wire protocol — the value is never
spliced into the text on the client.

## How it works

### Move 1 — the mental model

You already know this shape from React: when you render user text you do
`<span>{userText}</span>`, not `dangerouslySetInnerHTML`. The `{}` puts the
string in as a **text node** — data — so a value of `<script>` renders as
literal characters, not a tag. A bound SQL parameter is the same move at the
database layer: the value goes in as *data*, never as *markup the parser
acts on*.

```
  The shape — structure and value travel apart

       query text  ─────────────►  ┌──────────┐
       "...where app_id = $2"       │ Postgres │  1. parse structure
                                    │  parser  │     (placeholders, no values)
       params      ─────────────►  └────┬─────┘
       [ "'; drop table--" ]            │ 2. bind values into the
                                        ▼    already-parsed plan
                                   value is compared as a string;
                                   it can NEVER become a new clause
```

The one-sentence strategy: **parse the query shape first with holes in it,
then drop values into the holes** — the holes can't grow into new SQL.

### Move 2 — the walkthrough

**Part 1 — the placeholder.** Every query writes `$1`, `$2`, … where a value
goes, never the value itself. Drop this and you're back to string
concatenation: `where app_id = '${appId}'`, and an `appId` of
`' or '1'='1` reads every tenant's rows. The placeholder is the part that
makes the structure fixed before any value is seen.

```
  Placeholder vs concatenation — the one that breaks

  SAFE:    "select ... where app_id = $2"      + params [vec, appId, k]
  BROKEN:  "select ... where app_id = '" + appId + "'"

  in BROKEN, appId = "' or '1'='1"  →  where app_id = '' or '1'='1'
                                       → returns every row, all tenants
```

**Part 2 — the typed cast at the param site.** pgvector needs the embedding
as its `vector` type. The query casts the *placeholder*: `$1::vector`, not
`'[0.1,0.2]'::vector`. The cast applies to the bound value after binding, so
the vector literal string is still data, never SQL text. Drop the cast and
the value arrives as `text` and the distance operator `<=>` has no
overload — you get a type error, not injection, but the cast is what keeps
the value on the data side of the seam.

```
  The vector literal is a VALUE, cast after binding

  toVectorLiteral([0.1, 0.2])  →  "[0.1,0.2]"   (a JS string)
        │
        ▼ passed as param $1, NOT spliced into text
  "... 1 - (embedding <=> $1::vector) ..."
        │
        ▼ Postgres binds "[0.1,0.2]" then casts it to vector
  even if the string were hostile, it's compared as a vector,
  never parsed as SQL
```

**Part 3 — the one exception, and why it's not a sink.** The migration
runner (`migrate.ts`) does run a whole SQL *file* as one statement with no
parameters. That looks like the anti-pattern — raw SQL execution — but the
SQL comes from a repo-controlled file (`sql/001_agents_schema.sql`), never
from user input. The rule isn't "never run raw SQL"; it's "never let
*untrusted input* reach the SQL text." Repo-authored DDL is trusted by
definition.

### Move 3 — the principle

The principle generalizes past SQL: **separate the code from the data at
every interpreter boundary.** SQL parser, shell, HTML renderer, the LLM
prompt — each one is an interpreter, and injection is always the same bug:
a value crossed over into the structure the interpreter acts on. Bound
parameters are how you keep the value on the data side at the SQL boundary.
(Note the symmetry with `03-indirect-prompt-injection-surface.md`: the LLM
is *also* an interpreter, and there the data/code separation is *not* clean
— which is exactly why that one's a live surface and this one isn't.)

## Primary diagram

The full picture: untrusted values stay on the parameter rail the whole way
to Postgres.

```
  buffr-laptop — the SQL boundary, end to end

  ┌─ CLI / adapter (Node) ──────────────────────────────────────┐
  │                                                              │
  │   appId, k, vector[]  ──────────────┐  (values)              │
  │                                     │                        │
  │   "select id, content, ...          │                        │
  │    where app_id = $2                │                        │
  │    order by embedding <=> $1::vector│                        │
  │    limit $3"          ──────────┐   │  (fixed structure)     │
  │                                 │   │                        │
  └─────────────────────────────────┼───┼────────────────────────┘
              wire protocol:        │   │
              two separate fields ──▼───▼──────────────────────────
  ┌─ Postgres ─────────────────────────────────────────────────┐
  │  1. parse text  (holes, no values)                          │
  │  2. bind [vector, appId, k] into holes as typed values      │
  │  3. execute — values compared, never parsed as SQL          │
  └──────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Reached for on every database touch in the repo: indexing a
document's chunks (upsert), answering a question (search), reading the
profile, and writing the trajectory. There is no code path that builds SQL
by string concatenation — the pattern is uniform.

**Code side by side.**

```
  src/pg-vector-store.ts  (search, lines 70–78)

  const { rows } = await this.pool.query(
    `select id, content, chunk_index, document_id, meta,
            1 - (embedding <=> $1::vector) as score   ← $1 cast to vector
     from agents.chunks
     where app_id = $2                                ← $2 is the tenant value
     order by embedding <=> $1::vector
     limit $3`,                                       ← $3 is k
    [toVectorLiteral(vector), this.appId, k],         ← the param array
  );
        │
        └─ structure (the template string) and values (the array) are two
           separate arguments. node-postgres sends them as separate wire
           fields. No value is ever interpolated into the SQL text — strip
           the array and the query is still a complete, valid template.
```

```
  src/pg-vector-store.ts  (upsert, lines 47–56)

  await client.query(
    `insert into agents.chunks (id, document_id, app_id, ...)
     values ($1, $2, $3, $4, $5, $6::vector, $7, $8)  ← every column a placeholder
     on conflict (id) do update set ...`,
    [c.id, docId, this.appId, chunkIndex, content,
     toVectorLiteral(c.vector), this.embeddingModel, c.meta],  ← 8 bound values
  );
        │
        └─ content (the chunk text, indexed from a file) is $5 — a bound
           value. A document whose text is "'); drop table chunks;--" is
           stored as that literal string, never executed.
```

```
  src/runtime.ts  (document insert, lines 11–16)
  src/profile.ts  (profile read, line 5–6)
  src/supabase-trace-sink.ts  (message insert, lines 14–18)

  ...where app_id = $1            ← profile.ts
  values ($1, $2, 'markdown', $3, $4)  ← runtime.ts, note the literal
                                          'markdown' is repo-authored, not input
  values ($1, $2, $3, $4, $5)     ← trace-sink.ts
        │
        └─ same discipline in all three. The only string literals inside
           the SQL text ('markdown', table names) are authored by the repo.
           Everything caller-supplied is a $N.
```

## Elaborate

Parameterized queries are the original SQL-injection fix, older than the
ORMs that now do it for you under the hood. The reason they work is a
property of the database wire protocol, not the client library: the extended
query protocol (Parse / Bind / Execute) parses the statement *before* values
are bound, so a value can't retroactively change the parse tree. node-postgres
exposes this as the two-argument `query(text, values)` call. Drizzle (which
AdvntrCue uses) and every other serious driver wrap the same mechanism.

The thing worth internalizing: parameterization defends *structure*, not
*content*. It stops `' OR 1=1`, but it does nothing about a value that's
legal SQL-wise but wrong authorization-wise — like an `app_id` that lets you
read another tenant. That's a different boundary, and it's where
`02-shape-only-tenant-isolation.md` picks up. Parameterized SQL and tenant
isolation are orthogonal controls; this repo nails the first and defers the
second.

## Interview defense

**Q: This vector store builds a string literal `[0.1,0.2,...]` for the
embedding and puts it in the query. Isn't that string concatenation?**

No — and the distinction is the whole point. `toVectorLiteral` builds a JS
string, but that string is passed as a *bound parameter* (`$1::vector`),
never spliced into the SQL text. Watch where it goes:

```
  "[0.1,0.2]"  is a VALUE on the param rail, not text on the SQL rail

  query text:   "... embedding <=> $1::vector ..."   ← no value here
  params:       [ "[0.1,0.2]", appId, k ]            ← value lives here
                     │
                     └─ Postgres binds then casts to vector;
                        a hostile string is a bad vector, not new SQL
```

The anchor: **the literal is a value, the `$1` is the structure, and they
never meet on the client.** If I'd written `<=> '${literal}'::vector` —
interpolating into the text — *that* would be the bug. The cast on the
placeholder is what tells me it's safe.

**Q: What's the one thing parameterized queries do NOT protect you from?**

Authorization. They stop a value from changing query *structure*; they do
nothing about a value being *the wrong value you're not allowed to use*. A
parameterized `where app_id = $2` is injection-proof and still leaks every
tenant if `$2` isn't tied to a verified identity — which, in this repo, it
isn't yet (it's an env default). Naming that gap is the signal I understand
the control's edge.

## Validate

1. **Reconstruct.** From memory, write the two rails (SQL text, param array)
   and explain why a hostile `content` value in `pg-vector-store.ts:47` can't
   become executable SQL.
2. **Explain.** Why is `migrate.ts:13` running a raw SQL file *not* an
   injection sink, even though it executes unparameterized SQL?
3. **Apply.** A new feature lets the operator pass a `--source-type` flag
   that becomes a `WHERE source_type = ?` clause. Where does the value go —
   the SQL text or the param array — and what does the call look like
   (model it on `profile.ts:5-6`)?
4. **Defend.** Someone proposes "we should sanitize the question string to
   strip quotes before querying." Argue why that's the wrong fix and what's
   right instead.

## See also

- `02-shape-only-tenant-isolation.md` — the orthogonal control: structure
  is safe, but the `app_id` *value* isn't yet identity-bound.
- `03-indirect-prompt-injection-surface.md` — the same data/code-separation
  principle at the LLM boundary, where it does *not* hold cleanly.
- `study-data-modeling` — the schema these queries hit (`agents.chunks`,
  the JSONB `meta` column, the missing FK).
