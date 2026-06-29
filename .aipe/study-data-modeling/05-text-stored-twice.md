# Text stored twice (deliberate denormalization)

**Industry name(s):** denormalization / redundant storage of a derived field —
here the chunk text duplicated across the content column (`chunks.content`) and
the jsonb (`meta.text`). **Type:** Project-specific (a deliberate read-path
denormalization).

---

## Zoom out, then zoom in

You know normalization's core rule: store each fact once, so there's a single
source of truth and no way for two copies to disagree. This file is about a
spot where the repo *breaks* that rule on purpose — the chunk's text lives in
two columns at once — and whether the read-path simplicity it buys is worth the
write-path risk it creates.

```
  Zoom out — where the duplicate text lives

  ┌─ aptkit (in-memory meta shape) ──────────────────────────┐
  │  chunk.meta.text  ── citations / tool output read THIS    │ ← consumer
  └───────────────────────────────┬───────────────────────────┘
                                  │  upsert
  ┌─ PgVectorStore ───────────────▼───────────────────────────┐
  │  writes text into BOTH:                                   │
  │    content column  ◄── for the relational/SQL read        │
  │    meta jsonb (.text) ◄── to keep the in-memory shape      │ ← here
  └───────────────────────────────┬───────────────────────────┘
                                  │
  ┌─ Postgres (agents.chunks) ────▼───────────────────────────┐
  │  content text          ── copy #1                          │
  │  meta jsonb (.text)    ── copy #2  (same string)           │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: the question is "why is the same chunk string in two places, and which
one is the source of truth?" The answer is that neither is — they're kept in
sync only by the code that writes both. The `content` column exists so SQL can
select text directly; the `meta.text` copy exists so the rebuilt in-memory
`meta` matches the shape aptkit's citation code expects, unchanged. It's a
deliberate denormalization for read-path simplicity, and it's the one place a
reviewer should lean in.

---

## The structure pass

```
  One axis: "where is the chunk's text, and who keeps the copies equal?"

  ┌─ write path ─────────────────────────────────────────────┐
  │  upsert: content = meta.text   (both set from c.meta.text)│  app code
  └─────────────────────────┬────────────────────────────────┘  sets both
                            │  seam: nothing in the DB ties them
  ┌─ storage ───────────────▼────────────────────────────────┐
  │  content text   ┊   meta jsonb {.text}                    │  two copies,
  │  independently writable — no trigger, no generated column │  no DB link
  └─────────────────────────┬────────────────────────────────┘
                            │  seam: read REBUILDS one from the other
  ┌─ read path ─────────────▼────────────────────────────────┐
  │  search() drops meta.text on disk, rebuilds it FROM       │  content is
  │  content on the way out → content is the effective truth  │  effective SoT
  └──────────────────────────────────────────────────────────┘
```

The axis is **where the text lives and what keeps the copies equal**. The
revealing seam is the read path: `search()` rebuilds `meta.text` from the
`content` column, which means at read time `content` is the *effective* source of
truth and the stored `meta.text` is ignored. That's the subtlety — the
duplication is real on write but collapses to one truth on read. Knowing which
copy wins is the whole concept.

---

## How it works

### Move 1 — the mental model

You've cached a derived value in React state — `const [full, setFull] =
useState(first + ' ' + last)` — and then had to remember to update `full` every
time `first` or `last` changes, or it goes stale. Denormalization is that, in
the database: a second copy of a value that's only correct as long as something
keeps it in sync. The discipline you'd apply to that `useState` cache — one
update path that touches both — is exactly the discipline this table needs.

```
  Denormalization = a cached copy that can go stale

  source ──┐
           ├─► copy A (content column)
           └─► copy B (meta.text jsonb)

  safe ONLY if one write path sets both.
  two write paths → A and B can disagree → which is true? (leakage)
```

### Move 2 — the walkthrough

**On write, both copies come from the same source.** Inside `upsert`, the text
is pulled once from `c.meta.text` and then written into *both* the `content`
column and the `meta` jsonb (the whole `c.meta`, which still contains `.text`):

```ts
// pg-vector-store.ts:46  — text extracted once
const content = typeof c.meta.text === 'string' ? c.meta.text : '';

// pg-vector-store.ts:47-56  — written into BOTH content AND meta
await client.query(
  `insert into agents.chunks (id, document_id, app_id, chunk_index,
     content, embedding, embedding_model, meta)
   values ($1, $2, $3, $4, $5, $6::vector, $7, $8)`,  // $5 = content, $8 = c.meta (has .text)
  [c.id, docId, this.appId, chunkIndex, content, ..., c.meta],
);
```

`$5` is the `content` column; `$8` is the whole `meta` jsonb, which *includes*
`text`. So at write time the same string lands in two columns. Because both come
from the single `c.meta.text` in one statement, they're consistent *at write* —
the risk is later, if anything ever updates one without the other.

**On read, `meta.text` is thrown away and rebuilt from `content`.** The search
explicitly does *not* trust the stored `meta.text`. It selects the `content`
column and reconstructs the in-memory `meta` shape with `text` set from
`content`:

```ts
// pg-vector-store.ts:80-84
return rows.map((r) => ({
  id: r.id,
  score: Number(r.score),
  // Rebuild the in-memory meta shape so the search_knowledge_base tool's citations work.
  meta: { ...(r.meta ?? {}), docId: r.document_id, chunkIndex: r.chunk_index, text: r.content },
}));                                                                        // ← text from CONTENT
```

That last line is the tell: `text: r.content`. The stored `meta.text` is
overwritten by the `content` column on the way out. So **`content` is the
effective source of truth** — the `meta.text` copy on disk is dead weight at read
time. This is what makes the duplication *survivable*: even if the two ever
diverged on disk, reads would silently prefer `content`.

**Why duplicate at all, then?** Two reasons, both about contract-shape. (1) The
`content` column lets SQL read text directly — you can `select content` without
unpacking jsonb, which the relational read path wants. (2) Round-tripping the
*whole* `c.meta` (including its `text`) keeps the persisted `meta` identical to
the in-memory shape aptkit produced, so nothing about the citation/tool code has
to special-case "the persisted version is missing `text`." The repo chose to
spread `...r.meta` then override `text` rather than strip `text` before storing —
slightly more bytes on disk, zero shape divergence for the consumer.

**The boundary condition — both copies are independently writable.** Nothing in
the database ties `content` to `meta.text`. There's no generated column, no
trigger, no check constraint. If some future code path did `update chunks set
content = ...` without touching `meta`, or wrote `meta` without `content`, the
two would disagree — and which one a reader sees would depend on whether it reads
the column or the jsonb. Today that can't happen because the *only* writer is
`upsert`, which sets both from one source. But "only one writer" is a convention,
not a guarantee — the day a second write path appears, this becomes the classic
"same fact editable in two places" leakage. That's the load-bearing caveat a
reviewer names.

```
  The risk made concrete — two writers, one fact

  upsert (today)         → sets content AND meta.text together   ✅ consistent
  hypothetical patch     → update chunks set content = 'fixed'   ✗ meta.text stale
                            (reads via column see 'fixed';
                             reads via jsonb see old) → leakage

  the guard that DOESN'T exist: generated column / trigger / check
```

### Move 3 — the principle

Denormalization is a read-optimization you pay for in write-discipline. It's a
legitimate, common call — the rule isn't "never duplicate," it's "duplicate
only when you can name the read it speeds up *and* you control every write that
must keep the copies equal." Here both are true today: the `content` column
serves the SQL read, and `upsert` is the single writer. The honest reviewer
note is that the safety rests on "single writer," not on a database guarantee —
so the cheapest hardening, if a second writer ever appears, is to make `content`
a generated column derived from `meta->>'text'` (or stop storing `text` in
`meta` and rebuild it on read from `content`, which the read path already does).
The duplication-is-leakage primitive itself is taught in
**study-software-design**; the DB-specific lesson here is *which copy wins and
who keeps them equal*.

---

## Primary diagram

```
  Text stored twice — write sets both, read rebuilds one

  ┌─ write (upsert, pg-vector-store.ts:46-56) ────────────────┐
  │  c.meta.text ──┬──► content column  ($5)                  │
  │                └──► meta jsonb .text ($8, whole c.meta)   │
  │  ONE source, TWO destinations, ONE statement → consistent │
  └───────────────────────────────┬───────────────────────────┘
                                  │  on disk: two copies, no DB link
  ┌─ agents.chunks ───────────────▼───────────────────────────┐
  │  content text    ◄── effective source of truth            │
  │  meta jsonb .text ◄── ignored at read time                │
  └───────────────────────────────┬───────────────────────────┘
                                  │  read (search, :80-84)
  ┌─ rebuilt meta ────────────────▼───────────────────────────┐
  │  { ...meta, text: r.content }  ── text comes from CONTENT  │
  │  citations/tool see the in-memory shape, unchanged        │
  └────────────────────────────────────────────────────────────┘
```

---

## Elaborate

Denormalization shows up everywhere intentional: a `comment_count` cached on a
`posts` row to avoid a `COUNT(*)`, a customer's name copied onto an `orders` row
so the invoice doesn't change when they rename, a materialized view. Each trades
a read win for a sync obligation. The discipline that separates a good
denormalization from a bug is always the same: a single, owned write path, and a
clear answer to "which copy is authoritative." This repo has both — `upsert` is
the single writer, `content` is authoritative on read — which is why the call is
defensible rather than sloppy. What it lacks is a *database-level* guarantee of
that, which is the line between "fine for now" and "would fail a billing-system
review."

The normalization-as-information-hiding theory — single source of truth, why two
editable copies is leakage — lives in **study-software-design**. This file
cross-links rather than re-teaching it.

---

## Interview defense

**Q: The same text is in `content` and `meta.text`. Why, and which is true?**
Deliberate denormalization. The `content` column lets the SQL read path select
text without unpacking jsonb; storing the whole `meta` (which includes `text`)
keeps the persisted shape identical to aptkit's in-memory shape so citation code
needs no special-casing. Which is true? `content` — the read path rebuilds
`meta.text` from the `content` column (`text: r.content`, `pg-vector-store.ts:83`),
so the stored `meta.text` is ignored on read. One source on write
(`c.meta.text`), one authoritative copy on read (`content`).

```
  Q: two copies of the text — which wins?
  write: c.meta.text ──► content  AND  meta.text   (one statement, consistent)
  read:  text := content           (meta.text ignored)
  → content is the effective source of truth
  the risk people forget: it's "single writer," not a DB guarantee
```

**Q: When does this duplication become a bug?**
The moment a second write path touches one copy without the other. Today
`upsert` is the only writer and sets both, so they can't diverge. Add an `update
chunks set content = ...` somewhere and `meta.text` goes stale — readers hitting
the jsonb would see the old value. The safety is a convention ("one writer"), not
a constraint. The cheapest fix if that day comes: make `content` a generated
column from `meta->>'text'`, so the database keeps them equal. Naming that the
guarantee is conventional, not enforced, is the load-bearing admission.

---

## See also

- `01-vector-column-and-ann-index.md` — the read path that rebuilds `meta` from columns
- `02-deterministic-chunk-ids.md` — the `meta` round-trip that preserves the in-memory shape
- `audit.md` §2, §7 — normalization-and-duplication lens and the red-flag checklist
- **study-software-design** — duplication-as-leakage, the information-hiding primitive
