# stdout as the only log

**Industry names:** print-debugging / unstructured stdout / no-logger.
**Type:** Project-specific (the CLI-prints-results-is-the-log shape).

> Updated: 2026-06-24 — `ask-cmd.ts`'s `stdout.write(answer)` is gone; the answer now
> renders in the Ink TUI (`src/cli/chat.tsx`), which also *catches* errors and renders
> `error: <message>` instead of crashing to a stack trace. The remaining stdout-only
> commands are `index`, `eval`, and `migrate`. Print sites and `npm run ask` references
> updated below.

## Zoom out, then zoom in

You know how during early development you reach for `console.log` instead of wiring a
real logger, because the program is small and you're watching the terminal anyway?
buffr never left that stage — and deliberately so. Every command writes its *result*
to stdout, and that result-print is the entire logging story. No levels, no
timestamps, no structured fields, no log file. The output you read is the output the
program produces; there's no second channel.

```
  Zoom out — where the "logs" live

  ┌─ CLI layer (src/cli/{index,eval}-cmd.ts, src/migrate.ts) ────┐
  │  ★ process.stdout.write(...) ★                               │ ← we are here
  │  "indexed X" · P@1/R@3 · "migration applied"                 │
  └───────────────────────────┬──────────────────────────────────┘
                              │ (no logger between)
  ┌─ Chat TUI (src/cli/chat.tsx) ▼───────────────────────────────┐
  │  renders answer via Ink · catches errors → "error: <msg>"    │
  │  (not stdout-print; React-rendered, but still no logger)     │
  └───────────────────────────┬──────────────────────────────────┘
                              │
  ┌─ Agent / storage layers ──▼──────────────────────────────────┐
  │  emit traces to the DB (01) · throw raw Errors on failure    │
  │  no log lines at all                                         │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **result-as-log** — the program's user-facing output doubles
as its operational record, and there is no separate diagnostic stream. This is the
right call for a hand-run laptop tool and the exact thing that breaks the day it runs
unattended.

## Structure pass

**Layers.** Two relevant levels: the *success path* (commands print their result) and
the *failure path* (bare `throw` surfaces as an unhandled Node stack trace). They use
completely different mechanisms and neither is a logger.

**Axis — trace `how do I see what happened?` across success vs failure.**

```
  "how do I see what happened?" — success vs failure

  ┌──────────────────────────────────────┐
  │ success: stdout.write(result)        │   → I READ the result (it IS the log)
  └──────────────────────────────────────┘
  ┌──────────────────────────────────────┐
  │ failure: throw new Error(...)        │   → I READ a Node stack trace (uncontextualized)
  └──────────────────────────────────────┘

  the answer flips between paths: deliberate output vs accidental crash dump
```

**Seam.** The boundary that matters is success-path vs failure-path, and the contract
breaks across it: on success you get a clean, intentional line; on failure you get
whatever Node prints for an uncaught throw, with no buffr-side context (no "while
indexing file X", no run id). Same program, two unrelated observability stories.

## How it works

### Move 1 — the mental model

The shape is a **single write channel doing double duty** — `stdout` carries both the
answer to the human and, by accident, the only record that the step ran.

```
  one channel, two readers

  process.stdout.write("indexed foo.md\n")
            │
            ├──► the human running it   (intended: "it worked")
            └──► the operational record (accidental: "this step happened")

  there is no second channel. no log file, no level filter, no structured field.
```

What breaks when this is the only channel: you can't separate "tell the user" from
"record for later," so you can't raise verbosity for debugging without spamming the
user, and you can't grep a structured field because there are no fields — just
formatted English.

### Move 2 — the walkthrough

**The success lines — four hand-formatted strings.** Each command has exactly one
`stdout.write` (or two for eval) and it prints the result:

```
  the print sites — pseudocode

  index:    for each path:  stdout.write("indexed " + path)      // progress
  eval:     per query:      stdout.write(query + " P@1 .. R@3 ..") // scores
            then:           stdout.write("mean P@1 .. R@3 ..")
  migrate:  stdout.write("migration applied")                     // done marker
  chat:     (no stdout.write — answer rendered via Ink <Text>)    // TUI, not a print
```

These are *results*, not log events. `indexed foo.md` is the closest thing to an
operational log line (it marks a side effect happening), and it still has no level, no
timestamp, no document id beyond the path. Boundary condition: there's no way to tell
from the output whether `indexed foo.md` means "embedded and stored 12 chunks" or
"upserted a documents row and the embed silently returned nothing" — the line reports
the attempt, not the outcome.

**The failure path — split by surface.** The stdout commands (`index`, `eval`,
`migrate`) still fail by bare `throw` with no logging and no wrapping: a missing
`DATABASE_URL` throws a clear message (intentional guard), but a *runtime* failure —
Ollama down, Postgres unreachable, a wrong-dim embed — throws from deep inside `pg` or
the embedding provider, and the user sees that library's stack trace with no buffr
context. The chat TUI is the one surface that's different: `chat.tsx` wraps each
`session.ask` in a try/catch and renders `error: <message>` as a buffr turn instead of
crashing, so a per-turn failure no longer takes down the session.

```
  failure path — two surfaces now

  index/eval/migrate:  ollama down → embed throws (ECONNREFUSED)
        │  no catch, no log
        ▼  Node prints the raw stack trace, exits non-zero
           └─ honest but uncontextualized (which step? which input?)

  chat.tsx:  session.ask throws → catch → setTurns(error: <message>)
        │  the session survives; the next turn still works
        └─ contained, but still just the message string — no level, no run id
```

The one *good* failure boundary is the dimension guard in the vector store
(`assertDim` throws `dimension mismatch: got X, store is 768`) — that's a deliberate,
contextual error message. It's the exception that shows what the rest of the failure
path lacks.

**What's absent, and why it's absent.** No `winston`/`pino`, no log levels, no JSON
lines, no correlation id on the printed lines (the `conversationId` exists but never
appears in stdout), no redaction. This is correct for the phase: one operator, one
terminal, one command at a time. The absences become real costs only when the program
runs somewhere you're not watching — a cron index job, a long-lived service — at which
point "the answer is the log" stops working because nobody's reading the answer.

### Move 3 — the principle

Print-debugging scales exactly as far as a human watching the terminal, and not one
step further. The moment output is produced when nobody's looking — a scheduled job, a
background service, a second concurrent run interleaving its prints — result-as-log
collapses, because you can't filter it, can't search it, and can't tell two runs
apart. The principle: *a log is a separate channel from a result for a reason —
verbosity, structure, and searchability are the things a result can't give you,* and
buffr trades all three away for the simplicity that's correct while a human is at the
keyboard.

## Primary diagram

Every output site in one frame.

```
  buffr's entire stdout surface

  ┌─ Commands (success path) ─────────────────────────────────────────┐
  │  src/cli/index-cmd.ts:25   stdout.write("indexed " + path)        │
  │  src/cli/eval-cmd.ts:31    stdout.write(query + " P@1 .. R@.. ")  │
  │  src/cli/eval-cmd.ts:33    stdout.write("mean P@1 .. R@.. ")      │
  │  src/migrate.ts:31         stdout.write("migration applied")     │
  │  src/cli/chat.tsx          (Ink <Text> render, not stdout.write)  │
  └───────────────────────────────────────────────────────────────────┘
  ┌─ Failure path ────────────────────────────────────────────────────┐
  │  index/eval/migrate: throw → Node stack trace, no buffr context   │
  │  chat.tsx: catch → render "error: <message>" (contained per turn) │
  │  EXCEPT: PgVectorStore.assertDim → contextual "dimension mismatch"│
  └───────────────────────────────────────────────────────────────────┘

  no log levels · no timestamps · no JSON · no correlation id · no file
```

## Implementation in codebase

**Use cases.** Every batch command (`index`, `eval`, `migrate`) run from the terminal:
the output is read live by the operator; nothing persists it (the `messages` trace is a
separate, DB-side mechanism — see `01`). Reached for as both progress indicator and
result delivery. The chat answer is *not* on this surface — it's rendered in the TUI.

**The answer render — `src/cli/chat.tsx:28-34,42-47`.** No `stdout.write`; the answer
is React state painted by Ink.

```
  src/cli/chat.tsx  (lines 28–34)

  const answer = await session.ask(q);
  setTurns((t) => [...t, { role: 'buffr', text: answer }]);   ← answer → UI state
  ...
  catch (err) {
    setTurns((t) => [...t, { role: 'buffr', text: `error: ${(err as Error).message}` }]);
  }                                                            ← errors contained per turn
       │
       └─ the answer is rendered, and (when non-empty) also persisted as an
          assistant row via the trace (01). but a FALLBACK_ANSWER is shown here
          and NOT persisted — the screen and the trace store disagree (see 01 Move 3).
```

**The index progress — `src/cli/index-cmd.ts:22-26`.**

```
  src/cli/index-cmd.ts  (lines 22–26)

  for (const path of paths) {
    await indexDocumentRow(pool, cfg.appId, pipeline, { id: basename(path), text, sourcePath: path });
    process.stdout.write(`indexed ${path}\n`);   ← reports the attempt, not the outcome
  }
       │
       └─ no chunk count, no level, no timestamp. if the embed produced zero chunks
          this line still prints "indexed". the log can't distinguish success from
          a silent no-op.
```

**The migration marker — `src/migrate.ts:31`.**

```
  src/migrate.ts  (lines 29–31)

  await runMigration(pool, sql);
  await pool.end();
  process.stdout.write('migration applied\n');   ← prints only on the success path
       │
       └─ runMigration rolls back and re-throws on error (lines 12–16). so on
          failure you get the raw thrown error, never "migration FAILED" — the
          marker is success-only, asymmetric with the failure path.
```

## Elaborate

Result-as-log is the universal starting point — every project begins with
`console.log` and earns a real logger only when an absence bites. buffr is honestly at
that starting point, and the phase justifies it: a single-device, human-driven tool
doesn't need log levels because the human *is* the level filter. The migration to a
real logger becomes worth it at the first unattended run. The natural correlation key
already exists (`conversations.id`) — a structured logger would stamp it on every line
and suddenly two interleaved runs are separable. What to read next: `01` (the trace
store, the *other* evidence channel buffr does have) and `02` (the now-complete signal
that channel records). The `not yet exercised` log-level / structured-log / redaction
story is in `audit.md` lens 3.

## Interview defense

**Q: Your only logging is `process.stdout.write`. When does that stop working?**
The instant output is produced when nobody's watching the terminal. Result-as-log has
no level filter, no structure, and no correlation id, so you can't raise verbosity to
debug without spamming the user, can't grep a field because there are no fields, and
can't tell two interleaved runs apart. On a hand-run laptop tool that's all fine — the
human is the filter. The day it runs as a cron job or a service, it's blind.

```
  human watching  ──► result-as-log works
  nobody watching ──► no filter / no structure / no run id ──► blind
```

**Q: What's the asymmetry between your success and failure output?**
On the batch commands, success prints an intentional, formatted line and failure is a
bare `throw` that surfaces as a raw Node stack trace from inside `pg` or the embedder,
with no buffr context — which step, which input. The chat TUI is asymmetric the other
way: it *catches* per-turn errors and renders `error: <message>`, so it stays up but
gives you only the message string. The one place the throw is right is the vector
store's `assertDim`, which throws a contextual `dimension mismatch: got X, store is
768`. That's the model the rest of the failure path should follow: wrap the throw with
the operation and the input.

## Validate

1. **Reconstruct.** Name buffr's stdout write sites and what each reports, plus the one
   surface that renders instead of printing. (`index-cmd.ts:25`, `eval-cmd.ts:31`+`:33`,
   `migrate.ts:31`; `chat.tsx` renders via Ink.)
2. **Explain.** Why does `indexed foo.md` fail to distinguish a real index from a
   silent no-op? (`index-cmd.ts:25` — reports the attempt, no chunk count/outcome.)
3. **Apply.** Ollama is down during a chat turn vs during `eval`. Walk what each shows
   and what's missing. (chat: caught → `error: <msg>` rendered, session survives, no run
   id; eval: raw fetch/`pg` stack trace, exits non-zero — both miss level/structure.)
4. **Defend.** Argue whether buffr should adopt a structured logger now or stay on
   stdout/TUI. Name the single trigger that flips your answer. (Stay; flip at the first
   unattended/scheduled run, where nobody reads the result-as-log.)

## See also

- `01-trajectory-capture-as-observability.md` — the DB-side evidence channel.
- `02-discarded-trace-signal.md` — the full signal the DB trace channel now records.
- `05-eval-numbers-as-quality-signal.md` — the eval scores, another stdout-only signal.
- `audit.md` lens 3 — the `not yet exercised` structured-log / level / redaction notes.
