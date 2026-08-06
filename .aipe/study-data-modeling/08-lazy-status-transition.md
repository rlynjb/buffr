# Lazy status transition (state materialized on read)

**Industry name(s):** lazy expiry / read-time state materialization — here
`agents.decisions.status` flipping `open → review-due` inside `listDue()`.
**Type:** Industry standard (the same trick Redis uses for TTL keys),
applied to a status column instead of a key store.

---

## Zoom out, then zoom in

`04-app-id-tenant-column.md` already taught you one column that ships its
*shape* without its enforcement (`app_id`, no RLS). This file is a sibling
kind of half-built machinery, on the same new table: `agents.decisions` has a
`status` lifecycle (`open` → `review-due` → `resolved`), but nothing —
no cron, no scheduled job, no trigger — walks the table looking for rows
whose `review_at` has passed. The transition happens **inside the query
that lists due reviews**, as a side effect of reading.

```
  Zoom out — where the status flip actually happens

  ┌─ CLI (/review command) ──────────────────────────────────┐
  │  session.listDueReviews()                                 │ ← caller thinks
  └───────────────────────────────┬─────────────────────────────┘   this is a READ
                                  │
  ┌─ PgJournalStore.listDue ──────▼───────────────────────────┐
  │  1. UPDATE ... set status='review-due' where ... open      │ ← the WRITE
  │     and review_at <= now()                                 │   hiding inside
  │  2. SELECT ... where status='review-due'                   │   the "read"
  └────────────────────────────────────────────────────────────┘
```

Zoom in: the question is "who notices that a decision's review date has
arrived?" There's no scheduler in this codebase watching the clock. The
answer is: nobody, until the human runs `/review` — and at that exact
moment, the query that's supposed to *fetch* the due list also *writes*
the transition that makes them due. Reading and mutating in the same call
is the whole mechanism, and it's worth being able to name it on sight.

---

## The structure pass

```
  One axis: "what triggers the open → review-due transition?"

  ┌─ what you'd expect ──────────────────────────────────────┐
  │  a cron / worker / trigger watching review_at              │  NOT PRESENT
  └─────────────────────────┬────────────────────────────────┘
                            ╎  seam: no such process exists
  ┌─ what actually triggers it ──────────────────────────────┐
  │  listDue() — called only when a human runs /review         │  ON READ
  │  UPDATE fires first, SELECT reads the rows it just flipped │  (lazy)
  └──────────────────────────────────────────────────────────┘
```

The axis is **what triggers the transition**, and the seam is the absence
of anything proactive. Compare this to `chunks_embedding_hnsw`
(`01-vector-column-and-ann-index.md`), which is maintained continuously by
Postgres on every write — here, `status` is only ever brought up to date
the next time someone asks for it. That's the load-bearing property: a row
whose `review_at` passed yesterday still reads `status = 'open'` in the
database until the next `listDue()` call, even though *conceptually* it's
already due.

---

## How it works

### Move 1 — the mental model

You've used a JWT or a browser cookie with an `expiresAt` field. Nothing
deletes it the instant it expires — the expiry is *checked*, lazily, the
next time some code reads it ("is `Date.now() > expiresAt`? then treat it as
gone"). Redis TTL keys work the same way internally for a subset of cases:
rather than a background sweep for every key, an access can trigger the
expiry check. `agents.decisions.status` is that idea moved from
memory into a persisted column: instead of *deleting* on access, the row is
*rewritten* on access, so the next `SELECT` sees the flipped value too.

```
  Lazy transition — the check rides along with the read

  time:        ──────────●──────────────●───────────────►
               review_at reached   next listDue() call
                    │                     │
               status STILL 'open'   status flips here,
               in the DB (nobody     THEN gets read
               is watching)          (write-then-read,
                                      same call)
```

### Move 2 — the walkthrough

**The transition is two statements, not one, and the first is a plain
`UPDATE` — not a trigger, not a computed column.**

```ts
// src/pg-journal-store.ts:86-100 (PgJournalStore.listDue)
async listDue(userId: string, workspaceId: string, now: string): Promise<JournalEntry[]> {
  await this.pool.query(
    `update agents.decisions set status = 'review-due'
     where app_id = $1 and user_id = $2 and workspace_id = $3
       and kind = 'decision' and status = 'open' and review_at <= $4`,   // ← the WRITE
    [this.appId, userId, workspaceId, now],
  );
  const { rows } = await this.pool.query(
    `select * from agents.decisions
     where app_id = $1 and user_id = $2 and workspace_id = $3 and status = 'review-due'
     order by review_at asc`,                                             // ← the READ
    [this.appId, userId, workspaceId],
  );
  return rows.map(rowToEntry);
}
```

Call it `listDue` and a reader assumes `SELECT`-only, no side effects — the
name is honest about *what it returns*, not about *what it does first*. The
`UPDATE` runs unconditionally on every call, scoped to exactly the rows
that should have transitioned (`status = 'open' and review_at <= $4`), then
the `SELECT` reads back everything currently `review-due` — which now
includes rows the `UPDATE` on the very same call just flipped. **What
breaks if the `UPDATE` is removed:** the `SELECT` would only ever return
rows some *other* code path had already flipped to `review-due` — and no
other code path exists. Delete this `UPDATE` and `/review` permanently
returns nothing, no matter how overdue a decision is.

**The contract makes this explicit, not accidental — someone wrote it
down.** The JournalStore contract carries a comment specifically because
this is easy to reimplement wrong:

```ts
// packages/kernel/src/journal/contracts.ts:61-66
/**
 * listDue() is also where the open -> review-due transition happens: any
 * decision with status 'open' and reviewAt <= now is flipped to 'review-due'
 * as a side effect of being listed, then returned. Both implementations
 * must do this identically.
 */
```

"Both implementations" means `PgJournalStore` and the test double
`InMemoryJournalStore` — the comment is guarding against exactly the bug
where someone adds a fixture-friendly in-memory version that returns due
items without also flipping their status, and a test passes against the
fake while the real behavior (a second `/review` run skipping already-shown
items forever, since they never left `open`) silently breaks. This is a
contract that a type signature alone can't express — `Promise<JournalEntry[]>`
looks identical whether or not it mutates. Naming the side effect in the
doc comment is the only enforcement mechanism here; there's no test asserting
both implementations transition identically today, which is the honest gap.

**The index is shaped for both statements the transition needs, in one
pass.** `decisions_status_review` (`sql/002_decision_journal.sql:27`) is a
composite on `(app_id, user_id, workspace_id, status, review_at)` — exactly
the equality columns both the `UPDATE`'s `where` and the `SELECT`'s `where`
filter on, with `review_at` trailing for the `UPDATE`'s range check
(`<= $4`) and the `SELECT`'s `order by`. One index, two statements, both
served:

```
  decisions_status_review — one index, two queries

  columns:      app_id, user_id, workspace_id, status,        review_at
  UPDATE uses:  =        =        =             ='open'        <= now  (range)
  SELECT uses:  =        =        =             ='review-due'  ORDER BY (asc)
```

`kind = 'decision'` in the `UPDATE`'s `where` isn't in the index — it's a
residual filter applied after the indexed columns narrow the scan, which is
fine here because the index already gets the row count down to "this
tenant's open items due now," a small set on a personal tool.

**The boundary condition — this only fires when a human asks, so "due" is
a lie between visits.** A decision whose `review_at` was three weeks ago
still shows `status = 'open'` in the database until the next `/review`
call, even though it's obviously overdue by then. `dueReviewCount()`
(`session.ts:783-786`) calls the *same* `listDue`, so even a "how many are
due?" check triggers the write — there's no read-only way to ask the
question. For a personal CLI tool that's fine: the human is the only
trigger source that exists, and the flip landing "whenever you next look"
is indistinguishable in practice from "the moment it became due," since
nothing else in the system reacts to the status either way. The buildable
hardening, if this ever needed to notify or aggregate across users without
a human triggering a read, is a scheduled job running the same `UPDATE`
independently — the SQL doesn't change, only who calls it and when.

**One status the check constraint allows but no code path ever reaches.**
The `check (status in ('open', 'review-due', 'resolved', 'discarded'))`
(`sql/002_decision_journal.sql:13`) names four values. Only three are ever
written: `create()` inserts `'open'`, `listDue()` writes `'review-due'`,
`resolve()` writes `'resolved'` (`pg-journal-store.ts:110-116`). `snooze()`
does *not* introduce a `'snoozed'` status — it resets the row to `'open'`
with a new `review_at` (`pg-journal-store.ts:102-108`), which is the
correct call (a snoozed item is just an open item due later; a fourth
status would be redundant with `review_at`). `'discarded'` has no writer at
all: the research flow's "discard" choice returns `{ messages: ['Discarded
— nothing saved.'] }` and never calls `session.saveDecision` or any store
method (`research-flow.ts:112-115`) — a discarded prediction never becomes
a row, so there's no row left to mark `discarded`. The value sits in the
constraint as forward-compatible room (for a future "discard an already-
tracked decision" action) rather than dead code; naming it is the honest
move, not treating it as a bug.

### Move 3 — the principle

You don't need a scheduler for every "this becomes true at time T" fact —
you need one *only* if something has to react before anyone asks. When the
only consumer of "is this due yet" is a human who checks in periodically,
computing the transition at the moment of that check is strictly simpler
than running a background process to keep a column current between checks
nobody's making. The cost is honest: "due" can lag reality by however long
between visits, and any code path that reads status without calling the
same transition logic (there's exactly one path here, but a second one
would silently diverge) sees stale state. Lazy evaluation of a state
transition is a legitimate design, not a shortcut — as long as the
transition rule lives in exactly one place, which the doc comment on
`JournalStore.listDue` is working to guarantee.

---

## Primary diagram

```
  Lazy status transition — the full round trip

  ┌─ human runs /review ─────────────────────────────────────┐
  │  session.listDueReviews()  (session.ts:788)                │
  └───────────────────────────────┬─────────────────────────────┘
                                  │  journalStore.listDue(userId, workspaceId, now)
  ┌─ PgJournalStore.listDue (pg-journal-store.ts:86-100) ──────▼┐
  │  UPDATE agents.decisions                                    │
  │    set status='review-due'                                  │  step 1: WRITE
  │    where status='open' and review_at <= now                 │  (the side effect)
  │  ──────────────────────────────────────────────────────────│
  │  SELECT * from agents.decisions                             │  step 2: READ
  │    where status='review-due' order by review_at asc         │  (sees step 1's rows)
  └───────────────────────────────┬─────────────────────────────┘
                                  │  JournalEntry[]
  ┌─ review-flow.ts ──────────────▼─────────────────────────────┐
  │  keep → stays review-due   snooze → back to 'open', new date│
  │  resolve → 'resolved'      (review-flow.ts:70-108)           │
  └────────────────────────────────────────────────────────────┘
```

---

## Elaborate

Lazy expiry shows up wherever a "becomes true at time T" fact is cheaper to
check on access than to actively watch: JWT/cookie expiry, Redis's
access-triggered TTL eviction path, a subscription that's "expired" the
moment someone checks `renewsAt < now()` rather than a nightly job flipping
a flag. The tradeoff is always the same: you save the always-on watcher, you
pay in "the state can lag until someone looks." That tradeoff is *exactly*
right when the only consumer is the same actor who'd trigger the watcher
anyway — a human checking their own review queue, in this case. It stops
being right the moment a second consumer needs to react to "due" without
polling (a notification, a dashboard aggregating across users) — at that
point you need the scheduled job, and this file's SQL is already the
job's body, just waiting for something else to call it.

The `app_id`-shape-without-RLS story in `04-app-id-tenant-column.md` and this
one are siblings: both ship a column/mechanism whose *shape* is complete
(the `status` enum, the `review_at` comparison) while the *proactive*
half (RLS enforcement; a scheduler) is deliberately deferred to whenever a
second real consumer shows up.

---

## Interview defense

**Q: `listDue` sounds like a read. Why does it write?**
Because nothing else in the system watches `review_at` — there's no cron,
no trigger. The transition from `open` to `review-due` only has one trigger
source available: a human calling `/review`, which calls `listDue`. So the
function does the `UPDATE` first (`pg-journal-store.ts:88-92`), scoped to
exactly the rows whose `review_at` has passed, then `SELECT`s the
now-current `review-due` set. It's a lazy transition — state gets
materialized at the moment something reads it, the same trick a JWT's
expiry check uses. The contract doc comment
(`packages/kernel/src/journal/contracts.ts:61-66`) calls this out explicitly
so a future in-memory implementation doesn't skip the write and silently
break repeat `/review` runs.

```
  Q: why does a "list" method write?
  no scheduler exists → the only trigger is "someone asks"
  listDue = UPDATE (flip overdue rows) THEN SELECT (read them)
  same pattern as: JWT expiry checked on access, not swept proactively
```

**Q: What's the failure mode if a second caller reads `status` without
going through `listDue`?**
It sees stale state — a decision three weeks overdue still reads `open` if
nothing has called `listDue` since. `dueReviewCount()` avoids this by
calling the exact same `listDue` (`session.ts:783-786`), so today there's
only one code path and it can't diverge from itself. The risk is
structural, not present yet: any future query that filters `status='open'`
directly (say, a dashboard) would undercount without running the same
transition first. The fix, if that need arrives, is a scheduled job running
the identical `UPDATE` independently of any read — the SQL doesn't change.

---

## See also

- `04-app-id-tenant-column.md` — the sibling "shape shipped, proactive half
  deferred" call on this same table's tenant column
- `07-predicted-vs-assessed-columns.md` — the `review_at` field this file's
  index serves is the one field in that write path the DB actually compares
- `03-soft-link-no-fk.md` — another place enforcement moved out of the
  database and into a single, disciplined code path
- `audit.md` §4 — transactions-and-integrity, updated for this table
