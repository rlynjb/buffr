# User-Override Locks

*Industry name: override tracking / dirty-flag / last-write-wins protection. Type: **Language-agnostic** pattern.*

## Zoom out, then zoom in

When a pipeline re-runs and overwrites stored data, any *human edit* to that data gets silently clobbered. *User-override locks* are a flag (`_overridden_at`) that says "a person touched this — don't auto-overwrite." Here's where buffr writes data that could be clobbered, with the unprotected upserts marked ★.

```
buffr stack — where re-runs overwrite data
┌───────────────────────────────────────────────────────────┐
│ npm run index   re-chunk + re-embed a document              │
├───────────────────────────────────────────────────────────┤
│ ★ indexDocumentRow   documents: on conflict do update       │ blind overwrite
├───────────────────────────────────────────────────────────┤
│ ★ PgVectorStore.upsert   chunks: on conflict do update      │ blind overwrite
├───────────────────────────────────────────────────────────┤
│ agents.profiles (me.md)   loadProfile reads latest          │ user-editable, no lock
└───────────────────────────────────────────────────────────┘
```

Every re-index does `on conflict do update set ... = excluded.*` — last write wins, unconditionally. There are no `_overridden_at` fields anywhere. **This is Case B: not implemented.** Today it doesn't bite because re-indexing regenerates content from the source file (no human edits to lose) — but the `profiles` table (`me.md`) is the closest thing to user-editable data, and it's the natural place this pattern would land. This file teaches the lock and makes it the exercise.

## Structure pass — trace *who wins on conflict* across the data

Pick one axis: **when machine-written and human-written data collide, who wins?** Trace it.

```
conflict resolution, by table (buffr today)
  agents.documents │ on conflict do update → MACHINE wins │ no human edits exist
  agents.chunks    │ on conflict do update → MACHINE wins │ derived, regenerable
  agents.profiles  │ insert new row, read latest          │ human edits LIVE here ★
  ─────────────────────────────────────────────────────────────────────────────
  no seam: nothing checks "did a human touch this?" before overwriting
```

The seam that *should* exist is missing. A robust system asks, before overwriting: "is this row machine-owned (safe to clobber) or human-owned (must preserve)?" Buffr never asks — `excluded.*` wins every time. The consequence is latent: the moment any field becomes both machine-written *and* human-editable, a re-run erases the human's work with no warning.

## How it works

### Move 1 — the mental model: optimistic-UI conflict, but for a pipeline

You've hit this in frontend: optimistic UI updates local state, then a server response arrives and overwrites it — and if the user kept typing, their edits vanish. The fix is a "dirty" flag: don't overwrite a field the user is actively editing. Override locks are that dirty-flag, persisted: a column marking a row (or field) as human-touched, checked before any machine overwrite.

```
the dirty-flag shape
  machine wants to write row X
        │
  is X._overridden_at set?  (did a human edit it?)
        ├── yes ──▶ SKIP machine write (or write only non-overridden fields)
        └── no ───▶ overwrite freely
```

### Move 2 — the moving parts

#### The blind upsert, site 1: documents

`indexDocumentRow` (`src/runtime.ts:11–17`) overwrites the documents row unconditionally on re-index:

```ts
await pool.query(
  `insert into agents.documents (id, app_id, source_type, source_path, content)
   values ($1, $2, 'markdown', $3, $4)
   on conflict (id) do update set
     content = excluded.content, source_path = excluded.source_path`,   // ← human edits to content? gone.
  [doc.id, appId, doc.sourcePath ?? null, doc.text],
);
```

Annotation that matters: `content = excluded.content` means a re-index replaces stored content with whatever the source file says — no check for whether the row was edited since last index. Safe *today* (content mirrors the file), unsafe the instant content becomes editable in-app.

#### The blind upsert, site 2: chunks

`PgVectorStore.upsert` (`src/pg-vector-store.ts:47–56`) does the same for every chunk — embedding, content, meta all `= excluded.*`:

```ts
`insert into agents.chunks (...) values (...)
 on conflict (id) do update set
   document_id = excluded.document_id, ...,
   embedding = excluded.embedding, ..., meta = excluded.meta`   // ← unconditional, every field
```

This is *correct* for chunks — they're derived data, regenerated from the document, with no human-editable fields. Worth stating plainly: not every upsert *needs* a lock. Chunks shouldn't have one.

```
which upserts need a lock?
  documents.content │ could become human-editable │ NEEDS a lock eventually
  chunks.*          │ derived, regenerable         │ NO lock (correct as-is)
  profiles.content  │ already human-authored (me.md)│ NEEDS a lock ★
```

#### The actual at-risk data: profiles

`loadProfile` (`src/profile.ts:4–8`) reads the *latest* profile row — and `agents.profiles` (`sql/001_agents_schema.sql:52–58`) has `content` and `updated_at` but **no `overridden_at`**:

```sql
create table if not exists agents.profiles (
  id uuid primary key default gen_random_uuid(),
  app_id text not null default 'laptop',
  user_id text,
  content text not null,          -- ← me.md: human-authored, the thing to protect
  updated_at timestamptz not null default now()
);
```

Annotation that matters: profiles is *append-latest* (loadProfile orders by `updated_at desc`), so today a human edit and a machine write just create competing rows — the newest wins. There's no flag distinguishing "human wrote this" from "a future auto-profiler wrote this." The day buffr generates profile content automatically, it'll overwrite the user's `me.md` with no lock to stop it.

### Move 2.5 — current vs future state

**Current:** no override tracking. Documents and chunks upsert blindly (fine for derived data); profiles append-latest with no provenance flag. Nothing bites yet because no machine writes human-editable fields.

**Future (the exercise):** add `overridden_at timestamptz` to `profiles`. When a human edits the profile, set it. Any future machine writer checks it: if set, skip (or merge non-overridden fields only). This is the lock landing exactly where the at-risk data is.

```
current → future (profiles)
  CURRENT │ insert row, loadProfile reads latest → newest wins, no provenance
  FUTURE  │ overridden_at set on human edit
          │ machine write: overridden_at IS NULL ? overwrite : skip
```

### Move 3 — the principle that generalizes

> **Before a pipeline overwrites a field, ask whether a human owns it. Derived data (chunks) is free to clobber; human-authored data (the profile) needs a provenance flag, or your next re-run quietly deletes someone's work.**

The discriminator is *provenance*, not table. Within one row, some fields are machine-derived and some human-authored, and last-write-wins is correct for the former and a data-loss bug for the latter. The `_overridden_at` flag encodes provenance so the overwrite logic can branch on it. Buffr's chunks correctly need no lock; its profile correctly will. Knowing *which* is the skill.

## Primary diagram

The blind upserts, the at-risk profile, and the lock that's missing.

```
user-override locks (the missing flag)
  npm run index
        │
  ┌─────┴──────────────────────────────────────────────┐
  documents: on conflict do update content=excluded     │ blind (safe: mirrors file)
  chunks:    on conflict do update *=excluded            │ blind (CORRECT: derived)
  └──────────────────────────────────────────────────────┘
        │
  agents.profiles (me.md)  ── human-authored ──┐
        │                                       │
  loadProfile: order by updated_at desc         │  ← newest wins, NO provenance flag
        │                                       │
   ✗ no overridden_at  ──────────────────────────┘
  ───────────────────────────────────────────────────────────────
  FUTURE: overridden_at on profiles → machine write skips human-edited rows
```

## Elaborate

- **Origin.** The dirty-flag / optimistic-concurrency pattern from databases and collaborative editing (think Google Docs' "X is editing"). In data pipelines it's the "don't clobber manual overrides" rule — common in CRM/MDM systems where an enrichment job must not overwrite a human-corrected field.
- **Adjacent concepts.** *Provider abstraction* (08) — both are "data shape vs behavior" concerns the abstraction doesn't cover. *Data modeling* (cross-guide) — where the `profiles` schema and its provenance columns live. *Memory* (sub-section 04) — conversation memory writes are machine-only, so they correctly need no lock.
- **Honest gap.** **Not implemented** — no `_overridden_at`, no provenance flag, blind upsert everywhere. It doesn't bite today because no machine process writes human-editable fields. It's a latent bug that activates the moment buffr auto-generates profile content. Don't claim buffr "protects user edits"; it doesn't, it just hasn't had the collision yet.
- **What to read next.** Back up to the README, or jump to sub-section 02 (context & prompts) — the profile this lock protects is injected straight into the system prompt.

## Project exercises

### Add override tracking to the profiles table

- **Exercise ID:** [B1.17] (Phase 1 — LLM foundations) — **Not yet implemented** (Case B; no provenance flag exists).
- **What to build:** Add `overridden_at timestamptz` to `agents.profiles`; set it when a human edits the profile (e.g. via a `profile set` CLI); and add a guarded machine-write path that refuses to overwrite a profile whose `overridden_at` is set. Leave documents/chunks alone — they're derived and correctly need no lock.
- **Why it earns its place:** Lands the lock exactly where buffr's only human-authored data lives, before an auto-profiler can clobber `me.md`. Teaches provenance-based conflict resolution on real columns.
- **Files to touch:** `sql/001_agents_schema.sql:52` (add column); `src/profile.ts` (a guarded `saveProfile` that respects the flag); a new `src/cli/profile-cmd.ts` for the human edit path.
- **Done when:** a human-set profile survives a subsequent machine write attempt (the write is skipped because `overridden_at` is set), and a non-overridden profile still updates.
- **Estimated effort:** 1–4hr

### Audit which upserts are safe to clobber

- **Exercise ID:** [B1.18] (Phase 1 — LLM foundations)
- **What to build:** A short written audit (in the repo's docs, not a code change) classifying every `on conflict do update` in buffr as machine-owned (safe) or potentially human-owned (needs a lock), with the reasoning.
- **Why it earns its place:** Forces the provenance judgment this file's principle rests on, and documents *why* chunks need no lock while profiles will — so the next engineer doesn't add a pointless lock or miss a needed one.
- **Files to touch:** read-only against `src/runtime.ts`, `src/pg-vector-store.ts`, `src/profile.ts`; output a doc.
- **Done when:** every upsert in buffr is classified with a one-line rationale, and the profile is flagged as the one needing a lock.
- **Estimated effort:** <1hr

## Interview defense

**Q: "Buffr re-indexes with blind upserts. When is that a bug, and how would you fix it?"**

Model answer: It's correct for *derived* data and a latent bug for *human-authored* data. Chunks and document content are regenerated from the source file, so `on conflict do update set ... = excluded.*` is fine — last write wins, nothing human to lose. The risk is `agents.profiles` (the `me.md` text): it's human-authored and has no provenance flag, so the day buffr auto-generates profile content, a re-run silently overwrites the user's edits. The fix is an `overridden_at` column: set it on human edit, and have any machine writer skip rows where it's non-null. The discriminator is provenance, not table — within a row, some fields are safe to clobber and some aren't.

```
when blind upsert is a bug
  derived data (chunks, doc content)  │ clobber freely        │ OK
  human-authored (profiles/me.md)     │ needs overridden_at   │ BUG when auto-written
  ★ fix: provenance flag → machine skips human-edited rows
```

Anchor: *Clobber derived data freely; guard human-authored data with `overridden_at`.*

## See also

- `08-provider-abstraction.md` — the sibling "data shape vs behavior" concern.
- `06-token-economics.md` — another place buffr writes rows (model_usage) — machine-only, correctly lock-free.
- `../02-context-and-prompts/` — where the protected profile is injected into the system prompt.
