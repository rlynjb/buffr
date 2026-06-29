# User Override Locks

*Override flag / `_overridden_at` guard — Project-specific pattern (not yet exercised).*

## Zoom out, then zoom in

When an LLM *writes* a field that a human can also edit, you have a collision waiting: the next model re-run overwrites the human's careful manual edit. The fix is an override lock — a flag or timestamp that tells the writer "a human touched this; don't clobber it." buffr doesn't have this, because buffr has no LLM-written-and-user-editable field. Here's the data layer where it would live if it did.

```
  Zoom out — where an override lock WOULD live in buffr

  ┌─ Agent layer (aptkit) ──────────────────────────────────────────┐
  │  RagQueryAgent — produces ANSWERS (ephemeral, not stored fields) │
  └──────────────────────────┬───────────────────────────────────────┘
                             │  writes traces, never user-owned fields
  ┌─ Persistence layer (buffr) ▼─────────────────────────────────────┐
  │  agents.messages (trace)   ·   agents.profiles (USER-authored)   │
  │     ★ no LLM-written, user-editable field ★ ── lock would gate it │ ← would-be home
  └──────────────────────────┬───────────────────────────────────────┘
                             │
  ┌─ Storage (Postgres) ─────▼───────────────────────────────────────┐
  │  every column is either trace OR user-authored — never both      │
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in: an override lock is a per-row marker (`_overridden_at`, or a boolean `is_overridden`) that a regeneration job checks before writing. If the human edited the row, the timestamp is set, and the job skips it. The pattern needs *one precondition*: a field that **both** an LLM and a human write. buffr's data has no such field — `agents.profiles` is purely user-authored (the model never writes it), and `agents.messages` is purely a trace (the user never hand-edits it). No collision, no need for a lock. This file is honest about that and gives a Case-B where the lock *would* earn its place.

## Structure pass

Trace the axis **who is the authoritative writer of this field?** across buffr's two stored tables.

```
  Axis: "who writes this field authoritatively?" — buffr has no contested field

  ┌─ agents.profiles (me.md) ────────────────┐
  │  written by: USER only                    │  writer = HUMAN  (model reads, never writes)
  └─────────────────────┬─────────────────────┘
                        │  no seam — single writer
  ┌─ agents.messages (trace) ▼────────────────┐
  │  written by: TRACE SINK only              │  writer = MACHINE (user never hand-edits)
  └───────────────────────────────────────────┘

  the lock pattern needs a CONTESTED field (both write it) — buffr has none
```

The pattern's whole reason to exist is a *contested* field — one with two writers. buffr's tables each have a single, clear writer, so there's no seam where the authority flips, and therefore no race to guard. The lesson is structural: the override lock is the contract you add *exactly when* a field gains a second writer. Name the precondition and you know when to reach for it.

## How it works

#### Move 1 — the mental model

You know optimistic-concurrency in a form — a `version` or `updatedAt` you send back so the server rejects a stale write? An override lock is that, but the "stale writer" is specifically an *automated LLM re-run*, and the "winner" is always the human. The strategy: **stamp a row when a human edits it; the regeneration job reads that stamp and skips locked rows.**

```
  Pattern — the override lock (a guard clause on regeneration)

  LLM regeneration job, per row:
    if (row._overridden_at != null)        ← human touched it
        skip                               ← preserve the human edit
    else
        row.value = model.generate(...)    ← safe to (re)write

  human edit path:
    on user save → row.value = edit
                   row._overridden_at = now()   ← raise the lock
```

The lock is one nullable timestamp and one `if`. That's the entire kernel.

#### Move 2 — the step-by-step walkthrough

**Why the precondition is absent — the profile is user-only.** buffr's `loadProfile` *reads* the profile into the prompt; nothing ever writes it from the model.

```
  loadProfile — src/profile.ts (annotated)

  export async function loadProfile(pool, appId): Promise<string> {
    const { rows } = await pool.query(
      'select content from agents.profiles where app_id = $1 order by updated_at desc limit 1', [appId]);
    return rows[0]?.content ?? '';   // ← READ only; the model never writes agents.profiles
  }
```

The profile (`me.md`) is authored by the user and only *injected* into the system prompt (`rag-query-agent.ts:55-57`, `position:'start'`). The model consumes it; it never regenerates it. Single writer → no lock needed.

**Why the other table is machine-only — messages are a trace.** Everything in `agents.messages` is written by the trace sink as an append-only record; there's no UI to hand-edit a past message.

```
  SupabaseTraceSink.emit — supabase-trace-sink.ts:53-84 (annotated)

  switch (event.type) {
    case 'step':           this.push(persistMessage(... event.content ...));  // machine-written
    case 'tool_call_start':...                                                // machine-written
    case 'model_usage':    ...                                               // machine-written
  }   // ← every row is a TRACE; the user never edits these rows
```

Append-only machine writes, no human edits → again, no contested field, no lock.

**Where a lock would attach — the would-be regeneration path (Case B).** Suppose buffr added an LLM-written, user-editable field — say a model-generated **summary** of an indexed document, stored on `agents.documents`, that the user can hand-correct. *That* field is contested, and re-indexing would clobber the correction unless gated.

```
  Layers-and-hops — the lock buffr would add for an LLM-written summary

  ┌─ re-index job (buffr) ─────────────────────────────────────────┐
  │  for each document row:                                        │
  │    if (row.summary_overridden_at != null)  ── skip ────────────┼─► human edit preserved
  │    else: row.summary = model.generate(doc) ── write ───────────┼─► safe regen
  └───────────────────────────────┬────────────────────────────────┘
                                  │ user later corrects the summary in a UI
                                  ▼
  ┌─ Postgres: agents.documents ──────────────────────────────────┐
  │  summary TEXT   ·   summary_overridden_at TIMESTAMPTZ (lock)   │
  └────────────────────────────────────────────────────────────────┘
```

The lock is the `summary_overridden_at` column plus the `if` in the job. Without it, every re-index silently erases the user's correction — the exact failure the pattern prevents.

#### Move 2 variant — the load-bearing skeleton

Tiny kernel; name each part by what breaks without it.

```
  Kernel — user override lock

  1. a per-row LOCK marker (_overridden_at)  — drop it → no way to know a human edited
  2. a GUARD in the regen job (if locked skip)— drop it → re-run clobbers the edit anyway
  3. SET the marker on human edit             — drop it → marker never rises; guard never fires

  precondition (not hardening — REQUIRED): a field with TWO writers
                                            (LLM + human). buffr has none.
```

The forgotten part is **#3, raising the lock on edit** — teams add the column and the guard, then forget to *set* it in the save path, so the guard never triggers and edits still get clobbered. And the load-bearing precondition is the contested field: without two writers, the whole pattern is dead weight, which is precisely buffr's situation.

#### Move 3 — the principle

The moment a field has two writers — an LLM and a human — the human must win, and the cheapest enforcement is a per-row lock the regeneration job checks. Don't add it speculatively: the pattern's precondition is a *contested* field, and buffr deliberately has none (profiles are user-only, messages are trace-only). Knowing *when* the lock becomes necessary — the instant you let the model write a field a user can also edit — is the actual skill.

## Primary diagram

```
  User override lock — absent in buffr (no contested field), and where it'd go

  buffr TODAY — every field has ONE writer:
  ┌─ agents.profiles ─┐   ┌─ agents.messages ─┐
  │ USER writes       │   │ TRACE SINK writes │   no two-writer field → no lock
  │ [profile.ts]      │   │ [trace-sink.ts:53]│
  └───────────────────┘   └───────────────────┘

  CASE B — add an LLM-written, user-editable summary:
  ┌─ agents.documents ─────────────────────────────────────────┐
  │  summary (LLM writes)  +  summary_overridden_at (lock)     │
  │     re-index job: if overridden → SKIP, else regenerate    │
  │     user edit:    set summary + set summary_overridden_at  │
  └────────────────────────────────────────────────────────────┘
   the lock = one timestamp column + one if + set-on-edit
```

## Elaborate

The override lock is a special case of conflict resolution under multiple writers, and it picks a deliberately asymmetric policy: the human *always* wins over the automation. That's different from generic optimistic concurrency (last-write-wins or version-reject) because the two writers aren't peers — one is a person making a judgment, the other is a job that will happily run again tomorrow. The timestamp variant (`_overridden_at`) is preferred over a boolean because it also records *when*, which is useful for auditing and for "regenerate everything not touched since date X" sweeps.

For buffr the honest takeaway is that the pattern is correctly *absent*: adding a lock with no contested field would be complexity for nothing. The pattern becomes load-bearing the instant buffr lets the model write a user-editable field — the most likely candidates being LLM-generated document summaries or auto-extracted metadata that a user can correct. This connects to `04-structured-outputs.md` (an LLM-written field is often a structured-output field) and to the data-modeling concerns in the sibling `study-data-modeling` guide (where the `_overridden_at` column and its migration would be designed).

## Project exercises

No curriculum file present; exercises derived from the codebase. This concept is **not yet exercised** — Case B (introduce an LLM-written field and protect user edits).

### EX-09-1 — Add an LLM-written document summary with an override lock

- **Exercise ID:** EX-09-1
- **What to build:** Generate a short summary for each indexed document (a model call at index time), store it on a documents row with a `summary` and a nullable `summary_overridden_at`, and gate the index/re-index path to skip regenerating any summary whose lock is set.
- **Why it earns its place:** Creates the first genuinely contested field in buffr and protects it correctly — turning an abstract pattern into a working guard. Exercises the full kernel.
- **Files to touch:** `src/runtime.ts` (the index path, where `indexDocumentRow` runs), a migration for the new columns on the documents table, `src/cli/index-cmd.ts:22-26` (the indexing loop). Do not edit aptkit.
- **Done when:** re-indexing a document does NOT overwrite a summary whose `summary_overridden_at` is set, proven by a test that sets the lock then re-indexes.
- **Estimated effort:** 1-2 days

### EX-09-2 — Set the lock on user edit

- **Exercise ID:** EX-09-2
- **What to build:** A small command/path that lets a user overwrite a generated summary and, on save, stamps `summary_overridden_at = now()` — closing the loop so the EX-09-1 guard actually fires.
- **Why it earns its place:** The forgotten part of the pattern is raising the lock on edit; this exercise makes that the explicit deliverable.
- **Files to touch:** a new `src/cli/edit-summary.ts` (or extend an existing CLI); the documents-table update query.
- **Done when:** editing a summary sets the timestamp, and a subsequent re-index preserves the edit.
- **Estimated effort:** 1-4hr

## Interview defense

**Q: "Does buffr protect against an LLM re-run clobbering a user's edit?"**

It doesn't need to — there's no field both the model and the user write. The profile (`agents.profiles`) is user-authored and only read into the prompt; messages (`agents.messages`) are an append-only machine trace. With a single writer per field, there's no collision to guard, so adding an override lock would be complexity for nothing.

```
  no contested field → no lock needed

  profiles: USER only      messages: TRACE only
  (model reads)            (user never edits)
```

*Anchor:* read-only profile at `src/profile.ts`; append-only trace writes at `supabase-trace-sink.ts:53-84`.

**Q: "When *would* you add an `_overridden_at` lock here?"**

The instant the model writes a field a user can also edit — e.g. an LLM-generated document summary the user can correct. Then re-indexing would silently erase the correction unless the regen job checks the lock and skips locked rows. The kernel is one timestamp column, an `if` in the job, and setting the stamp on edit.

```
  add the lock when a field gains a SECOND writer

  summary: LLM writes + USER edits → contested → needs _overridden_at
```

*Anchor:* the would-be home is the index path (`src/runtime.ts` / `src/cli/index-cmd.ts:22`), not aptkit.

## See also

- `04-structured-outputs.md` — LLM-written fields are usually structured-output fields.
- `06-token-economics.md` — a summary-generation field would add model calls to meter.
- `08-provider-abstraction.md` — the model that would write the contested field.
- `../03-retrieval-and-rag/11-rag.md` — the index path where a generated summary would attach.
