# Study — Data Modeling · `buffr-laptop`

The question this guide answers: **does the data's shape match how it's
actually read and written — and can it stay correct?** Code is cheap to
change; a schema with live embeddings in it is not. Every finding below is
anchored to the real schema (`sql/001_agents_schema.sql`) and the code that
reads and writes it.

```
  The two partition seams — what's HERE vs what's NEXT DOOR

  ┌─ study-data-modeling (HERE) ───────────────────────────────┐
  │  the SHAPE of persistent data: the six tables, the         │
  │  soft link, the vector column, normalization, indexes      │
  │  vs queries, integrity, migrations                         │
  └────────────────────────────────────────────────────────────┘
        │  seam 1: "shaped wrong / query has no index" → HERE
        │          "which datastore / shard / replicate" → next door
        ▼
  ┌─ study-system-design ──────────────────────────────────────┐
  │  WHICH datastore (Postgres), single-device, no replicas    │
  └────────────────────────────────────────────────────────────┘
        │  seam 2: "a B-tree/HNSW index on disk" → HERE
        │          "a heap in memory" → next door
        ▼
  ┌─ study-dsa-foundations ────────────────────────────────────┐
  │  in-memory data structures (the HNSW graph as an algorithm)│
  └────────────────────────────────────────────────────────────┘
```

Two seams, stated up front. Against **system-design**: "use Postgres,
single-device, no replica this phase" is architecture and lives there;
"the chunks table dropped its foreign key" and "the ANN query filters on
`app_id`" is data-modeling shape and lives here. Against **dsa-foundations**:
the HNSW graph *as an algorithm* (greedy layered nearest-neighbour walk) is
DSA; the HNSW *index on the embedding column, the queries it serves* is data
modeling. And normalization is information-hiding for data — single source of
truth, no fact stored twice — so where this repo stores text twice, the deep
"why duplication is leakage" teaching cross-links to **study-software-design**
rather than re-teaching it.

---

## The schema, in one diagram

Six tables in the `agents` schema (database `reindb`), across two migrations.
One real foreign key. One deliberately dropped one. One table (`chunks`) does
double duty — it holds both retrieval chunks and episodic memory; `decisions`
does the same move with a `kind` column instead.

```
  agents schema — the data model as-built
  (sql/001_agents_schema.sql + sql/002_decision_journal.sql)

  ┌─ documents ──────────────┐         ┌─ profiles ───────────────┐
  │ id          text PK      │         │ id        uuid PK        │
  │ app_id      text         │         │ app_id    text           │
  │ source_type text         │         │ user_id   text           │
  │ content     text         │         │ content   text           │
  │ meta        jsonb        │         │ updated_at timestamptz   │
  │ created_at  timestamptz  │         └──────────────────────────┘
  └────────────┬─────────────┘
               ╎  SOFT LINK — chunks.document_id, NO foreign key
               ╎  (constraint deliberately dropped, line 27)
               ▼
  ┌─ chunks ─────────────────────────────────────────────────────┐
  │ id           text PK   ── "<docId>#<index>"  OR               │
  │                           "memory:<conv>:<n>"  (meta.kind)    │
  │ document_id  text      ── soft link, nullable                 │
  │ app_id       text      ── tenant discriminator, indexed       │
  │ chunk_index  int                                              │
  │ content      text      ◄─┐ text stored TWICE                  │
  │ embedding    vector(768) │  (content column AND meta.text)    │
  │ meta         jsonb     ──┘  HNSW vector_cosine_ops on embedding│
  └──────────────────────────────────────────────────────────────┘

  ┌─ conversations ──────────┐         ┌─ messages ───────────────┐
  │ id        uuid PK        │◄────────│ conversation_id uuid FK  │
  │ app_id    text           │ ON      │   → conversations(id)    │
  │ user_id   text           │ DELETE  │   on delete CASCADE      │
  │ agent_name text          │ CASCADE │ role text                │
  │ created_at timestamptz   │         │ content text             │
  └──────────────────────────┘         │ tool_calls   jsonb       │
                                       │ tool_results jsonb       │
        the ONE real FK ───────────────│ model        text        │
                                       │ tokens_used  int         │
                                       │ created_at   timestamptz │
                                       └──────────────────────────┘

  ┌─ decisions ─────────────────────────────────────────────────┐  NO LINK
  │ id uuid PK · app_id/user_id/workspace_id text (collapsed     │  at all —
  │   to one value today) · domain · subject_type/subject_id     │  not even
  │   (points OUTSIDE this db — no table to join)                │  soft
  │ kind 'hypothesis'|'decision'  ── discriminates the family    │  (see
  │   below, same move as chunks' meta.kind overload)            │  03, 07)
  │ status 'open'→'review-due'→'resolved'/'discarded'            │
  │   (transitioned LAZILY, inside listDue() — see 08)           │
  │ predicted_score/dimension/confidence  ◄─┐ TWO FACTS, not one │
  │ assessed_score/confidence             ──┘ duplicate — see 07 │
  │ stake, resolution_condition (free text) · review_at (indexed)│
  │ evidence_ids jsonb[]  ── sourceId strings, never persisted    │
  │   anywhere in this db                                        │
  └────────────────────────────────────────────────────────────────┘
```

Read that diagram before opening anything else. The two interesting joints in
the original five tables — the dashed soft link and the solid cascade FK —
are the whole story of how that half of the schema enforces (and chooses not
to enforce) integrity. `decisions` adds a third story: a table with no joint
to any other table at all, twin columns that look like duplication but
aren't, and a status column that only advances when someone reads it.

---

## Reading order

```
  00-overview.md   one-page orientation: the six tables, the verdict
  audit.md         Pass 1 — all 7 data-modeling lenses walked, honest
                   "not yet exercised" where the repo doesn't go there

  Pass 2 — the patterns this repo actually exercises:
  01-vector-column-and-ann-index.md     embedding vector(768) + HNSW
  02-deterministic-chunk-ids.md         the natural key "<docId>#<index>"
  03-soft-link-no-fk.md                 the deliberately dropped FK
  04-app-id-tenant-column.md            tenant shape without RLS
  05-text-stored-twice.md               deliberate denormalization
  06-trajectory-tables.md               conversations + messages full-signal
  07-predicted-vs-assessed-columns.md   decisions' forecast/actual twin columns
  08-lazy-status-transition.md          decisions' status flips on read, not on a schedule
```

Start at `00-overview.md`, then `audit.md` for the systematic sweep, then the
pattern files worst-first or by curiosity. Each pattern file is
self-contained and uses the full concept-file format.

---

## Cross-links to the rest of the study family

- **study-database-systems** — the storage engine *under* this schema: how
  HNSW is laid out on disk, how the `<=>` operator executes, MVCC behind the
  `begin/commit` in `upsert`. This guide is the schema shape; that guide is
  the engine beneath it.
- **study-security** — `app_id` is a tenant discriminator with **no RLS** and
  is **not token-derived**. That's a data-modeling shape decision here and a
  trust-boundary decision there. See `04-app-id-tenant-column.md`.
- **study-system-design** — single-device Postgres, SQLite-canonical sibling
  (`buffr` mobile), the storage-choice rationale. The "which datastore and how
  it scales" half lives there.
- **study-software-design** — normalization as information-hiding; the
  text-stored-twice call (`05-text-stored-twice.md`) is the DB analog of the
  duplication primitive taught there.
- **study-agent-architecture** — the predict → reveal → promote flow that
  writes `agents.decisions` (`src/cli/research-flow.ts`) is a data-modeling
  concern here (what the row shape captures) and an agent-loop concern there
  (how the multi-turn CLI state machine drives it). See
  `07-predicted-vs-assessed-columns.md`.
