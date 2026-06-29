# stdout-as-Only-Log

**Industry name(s):** unstructured stdout logging / `print`-debugging-as-logging, the absence of structured logging — *Project-specific* observation of an *Industry anti-pattern* (named honestly because the repo earns it at its current scope).

Outside the trace table, buffr's entire logging surface is `process.stdout.write`. The CLIs print human sentences — "indexed X", the answer, the eval numbers — and that's it. No log levels, no structured fields, no correlation IDs, no durable error trail. This file names what that costs you and exactly where it bites.

---

## Zoom out, then zoom in

Here's the honest picture. Structured logging (absent — `process.stdout.write`) means the only thing standing between you and a production mystery is whatever sentence a CLI happened to print to the terminal.

```
  Zoom out — the logging surface (or lack of one)

  ┌─ CLI layer (src/cli/) ──────────────────────────────────────┐
  │  index-cmd.ts → process.stdout.write("indexed X\n")  ★ here ★│
  │  eval-cmd.ts  → process.stdout.write(P@1 / R@3)      ★ here ★│
  │  chat.tsx     → Ink render; catch → render "error:…" inline  │
  └────────────────────────────────┬─────────────────────────────┘
            no level / field / id   │
  ┌─ Session / Sink layer ─────────▼─────────────────────────────┐
  │  (the trace table lives here — the ONE structured surface)   │
  │  but session.ts:66-68 swallows memory errors with NO log     │
  └────────────────────────────────┬─────────────────────────────┘
  ┌─ Storage ──────────────────────▼─────────────────────────────┐
  │  agents.messages (structured) — but stdout reaches it never  │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in. The question: *when something outside a turn goes wrong — indexing, an eval, a pool error, a swallowed memory write — what evidence is left behind?* The answer for buffr is "a line in the terminal, if you were watching, and nothing if you weren't." The pattern (anti-pattern) is **stdout is the log**: no severity to filter on, no fields to query, no sink that outlives the scrollback.

## The structure pass

**Layers:** the CLI (writes sentences) → the process stdout stream (ephemeral) → wherever the terminal was pointed (usually nowhere durable).

**Axis — "what survives the process exiting?"** Trace it:

```
  One question down the layers: what survives process exit?

  ┌──────────────────────────────────────────────┐
  │ CLI command (index-cmd / eval-cmd)            │  → in-memory string
  │   process.stdout.write("indexed X")           │
  └───────────────────────┬───────────────────────┘
       seam: write()       │  ═══ structure is LOST here ═══
  ┌───────────────────────▼───────────────────────┐
  │ stdout stream                                 │  → bytes, no fields
  │   no level, no JSON, no timestamp, no id       │    (can't filter/query)
  └───────────────────────┬───────────────────────┘
       seam: terminal      │  ═══ durability decided here ═══
  ┌───────────────────────▼───────────────────────┐
  │ terminal scrollback (usually)                 │  → GONE on exit
  └────────────────────────────────────────────────┘
```

**The load-bearing seam is `write()`** — the moment a structured fact ("indexed the file at this path, producing N chunks") collapses into an unstructured sentence ("indexed X"). Everything observable about the operation that *isn't* in that sentence is gone at that seam. Contrast this with `01-`'s trace table, which crosses the same kind of boundary but keeps the structure. The two patterns are the same boundary handled opposite ways.

## How it works

#### Move 1 — the mental model

You know the difference between `console.log("loading…")` scattered through a component and a proper logger with `logger.info({ event: 'fetch_start', url })`. The first is print-debugging — fine while you're staring at it, useless an hour later. The second is structured logging — every line is a queryable record. buffr's CLI surface is entirely the first kind.

```
  The shape — what stdout drops vs what a structured log keeps

  the event:  "indexed /docs/me.md → 12 chunks in 340ms, app_id=laptop"

  stdout (buffr):           process.stdout.write("indexed /docs/me.md\n")
                            └─ keeps: the path
                            └─ drops: chunk count, duration, app_id,
                                      level, timestamp, correlation id

  structured (absent):      { level:'info', event:'index', path:…, chunks:12,
                              ms:340, app_id:'laptop', ts:… }
                            └─ every field queryable, filterable, alertable
```

The diagram is the whole lesson: the operation *knows* its chunk count and `app_id` (`indexDocumentRow` has them), but the log line throws them away.

#### Move 2 — the step-by-step walkthrough

**The index CLI's log line.** One sentence per file, no fields (`src/cli/index-cmd.ts:22-26`):

```
  src/cli/index-cmd.ts:22   for (const path of paths) {
  :23     const text = await readFile(path, 'utf8');
  :24     await indexDocumentRow(pool, cfg.appId, pipeline, { id: basename(path), … });
  :25     process.stdout.write(`indexed ${path}\n`);   // ← the entire log
  :26   }
```

`indexDocumentRow` just ran an INSERT and a full chunk-indexing pass — it knows how many chunks it produced and which `app_id` it wrote under. None of that reaches the log line. If indexing silently produced zero chunks (an embedding-dimension mismatch caught upstream, say), stdout still cheerfully prints "indexed X." The boundary condition: **the success line fires on completion, not on correctness** — there's no signal distinguishing "indexed well" from "indexed badly but didn't throw."

**The eval CLI's numbers.** Same shape, but here the numbers are the *point* — so this line is doing more work (`src/cli/eval-cmd.ts:31-33`):

```
  src/cli/eval-cmd.ts:31   process.stdout.write(`${query.padEnd(44)} P@1 ${p.toFixed(2)} …\n`);
  :33   process.stdout.write(`\nmean P@1 …  mean R@3 …\n`);
```

These P@1 / R@3 numbers are real retrieval-quality signal — but they're *printed*, not *recorded*. No run is stored, so you can't diff today's mean against last week's without copy-pasting terminal output. → `04-eval-numbers-as-quality-signal.md` treats this as its own pattern.

**The chat UI's caught error — rendered, not logged.** `chat.tsx` catches per-turn errors so one bad turn doesn't kill the session (`src/cli/chat.tsx:30-31`):

```
  src/cli/chat.tsx:30   } catch (err) {
  :31     setTurns((t) => […, { role: 'buffr', text: `error: ${(err as Error).message}` }]);
```

Good resilience UX. But notice what's *not* here: no `console.error`, no persist, no stack. The error message lands in the Ink render and the terminal scrollback; the moment the user scrolls or exits, it's gone. If the throw happened before `trace.flush()`, the trace table has no record either — so a failed turn can leave **zero durable evidence**.

**The silent memory swallow — not even a sentence.** `session.ask()` wraps the episodic-memory write in an empty catch (`src/session.ts:64-69`):

```
  src/session.ts:64   try {
  :65     await memory.remember({ conversationId, question, answer });
  :66   } catch {
  :67     // swallow: memory is best-effort, the turn already succeeded
  :68   }
```

This is the *opposite* end of the spectrum from stdout — not even an unstructured line. The decision is correct (a memory failure must not lose the user's answer), but the observability cost is total: episodic memory can silently stop working and nothing — not stdout, not the trace, nothing — records that it did.

#### Move 2 variant — the load-bearing skeleton

What's *missing* that a structured-logging layer would add, named by what its absence breaks:

1. **Severity levels** — without `info`/`warn`/`error`, you can't filter noise from signal; every line is equal weight. (absent everywhere)
2. **Structured fields** — without `{ path, chunks, app_id }`, you can't query "all indexing runs for app_id=laptop"; you'd grep prose. (`index-cmd.ts:25`)
3. **A durable sink** — without shipping logs somewhere, they die with the terminal; the swallowed memory error (`session.ts:66`) is the proof.
4. **A correlation id in the log line** — the trace table *has* `conversation_id`, but the stdout surface doesn't carry it, so you can't tie a printed line back to a turn.

The honest framing: at buffr's scope — single-device, a human at the terminal — stdout is a *defensible* choice, not negligence. The human watching the terminal *is* the log sink. The pattern earns a file because the moment buffr runs unattended, every item above flips from "fine" to "blind spot," and the swallowed memory error is already a blind spot today.

#### Move 3 — the principle

**A log line is only as useful as the fields it carries and the sink it survives in.** Printing a sentence to stdout answers "is it running" for a human watching live; it answers nothing for a human debugging after the fact. The general rule: if an operation knows a fact worth acting on (chunk count, error cause, `app_id`), the log should carry it as a *field*, not bury it in prose or drop it entirely.

## Primary diagram

```
  stdout-as-only-log — the four surfaces, ranked by evidence left

  surface                  on success        on failure          durable?
  ───────────────────────  ────────────────  ──────────────────  ────────
  index-cmd.ts:25          "indexed X"       (throws, uncaught)  no
  eval-cmd.ts:31-33        P@1 / R@3 lines   (throws, uncaught)  no
  chat.tsx:30-31           (trace row)       render "error:…"    no (scroll)
  session.ts:66-68 memory  (trace row)       SILENT — nothing    no — none

       ▲                                          ▲
   the ONE good surface is elsewhere:         the worst case:
   agents.messages (01-, 02-)                 a swallowed error
   — structured, durable, queryable           with zero evidence
```

## Elaborate

The reason this is worth a file rather than a one-line audit note: it's the exact inverse of buffr's *good* observability. `01-full-signal-trajectory-capture.md` shows the repo at its best — typed events, durable rows, a correlation key, queryable fields. The stdout surface shows the same team's *other* default — prose to a stream that dies on exit. The contrast is the lesson: buffr knows how to do structured logging (it built the trace table) but only applied it to the agent trajectory, leaving the CLI and the error paths on print-debugging.

The constructive move, in order of leverage: (1) persist the chat UI's caught error and the swallowed memory failure to *something* durable — even a row in `agents.messages` with `role='error'`, which the sink already supports (`src/supabase-trace-sink.ts:80-83`); (2) give the index/eval CLIs structured output (JSON lines with fields) behind a flag so they stay human-readable by default; (3) only then reach for a logging library and levels. The first move costs almost nothing and closes the worst blind spot — the silent failures.

## Interview defense

**Q: Your CLI prints "indexed X" and exits 0. The retrieval is broken. How would you have caught it?**

```
  the success line fires on completion, not correctness

  indexDocumentRow() ──► (returns) ──► "indexed X"  ✓ printed
        │
        └─ knew: chunk count, app_id, dimension — none logged
           a 0-chunk index prints the same "indexed X"
```

You wouldn't, from stdout — the print fires on completion, not correctness (`index-cmd.ts:25`). The fix is a structured line carrying the chunk count and `app_id` the operation already has, so "indexed X → 0 chunks" is visibly wrong. **Anchor:** the field-less `process.stdout.write` at `index-cmd.ts:25` — completion is not correctness.

**Q: What's the single worst observability hole in the repo?**

The empty catch on the memory write (`session.ts:66-68`). It's the only place a real state-change failure leaves *zero* evidence — not a stdout line, not a trace row, nothing. The decision to swallow is right (don't lose the user's answer), but the *silence* is the bug: it should persist an `error` row, which the trace sink already handles. **Anchor:** `catch { // swallow }` at `session.ts:66`.

## See also

- `01-full-signal-trajectory-capture.md` — the structured surface this one is the inverse of.
- `04-eval-numbers-as-quality-signal.md` — the eval stdout, treated as its own signal.
- `audit.md` lens 3 (structured logs), lens 6 (debugging boundaries), lens 8 (red-flag rank 3 & 5).
- Cross-guide: `study-testing` (the eval as a regression guard, not a log).
