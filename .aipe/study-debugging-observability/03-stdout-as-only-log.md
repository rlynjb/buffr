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
  │  chat.tsx     → OpenTUI render; catch → render "error:…" inline  │
  └────────────────────────────────┬─────────────────────────────┘
            no level / field / id   │
  ┌─ Session / Sink layer ─────────▼─────────────────────────────┐
  │  (the trace table lives here — the ONE structured surface,   │
  │  /ask only) but session.ts:686-690 swallows memory errors    │
  │  with NO log, and /research never reaches a trace at all     │
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

**The index CLI's log line.** One sentence per file, no fields (`src/cli/index-cmd.ts:35-39`):

```
  src/cli/index-cmd.ts:35   for (const path of files) {
  :36     const text = await readFile(path, 'utf8');
  :37     await indexDocumentRow(pool, cfg.appId, pipeline, { id: basename(path), … });
  :38     process.stdout.write(`indexed ${path}\n`);   // ← the entire log
  :39   }
```

`indexDocumentRow` just ran an INSERT and a full chunk-indexing pass — it knows how many chunks it produced and which `app_id` it wrote under. None of that reaches the log line. If indexing silently produced zero chunks (an embedding-dimension mismatch caught upstream, say), stdout still cheerfully prints "indexed X." The boundary condition: **the success line fires on completion, not on correctness** — there's no signal distinguishing "indexed well" from "indexed badly but didn't throw."

**The eval CLI's numbers.** Same shape, but here the numbers are the *point* — so this line is doing more work (`src/cli/eval-cmd.ts:33-35`):

```
  src/cli/eval-cmd.ts:33   process.stdout.write(`${query.padEnd(44)} P@1 ${p.toFixed(2)} …\n`);
  :35   process.stdout.write(`\nmean P@1 …  mean R@3 …\n`);
```

These P@1 / R@3 numbers are real retrieval-quality signal — but they're *printed*, not *recorded*. No run is stored, so you can't diff today's mean against last week's without copy-pasting terminal output. → `04-eval-numbers-as-quality-signal.md` treats this as its own pattern.

**The chat UI's caught errors — rendered, not logged, and now at six-plus call sites.** `chat.tsx` catches per-turn and per-flow errors so one bad turn doesn't kill the session. The original `/ask` path uses the two-arg `.then(success, error)` form (`src/cli/chat.tsx:367-376`):

```
  src/cli/chat.tsx:372   err => {
  :373     setTurns(t => [...t, { role: 'buffr', text: `error: ${(err as Error).message}`, stats: capturedStats }]);
  :374     setBusy(false);
  :375   },
```

`26f0e4b` extended the identical shape to three more sites — the active-flow interceptor (`:184-188`), `/research` start (`:309-313`), and `/review` start (`:350-354`) — after all three had originally used single-arg `.then(result => …)`, which silently swallowed a rejection and left the UI permanently stuck (`busy: true`, input hidden). The fix pattern is right; the *durability* is unchanged: none of the six-plus sites do more than render the message into the transcript. No `console.error`, no persist, no stack. The error lands in the OpenTUI render and the terminal scrollback; the moment the user scrolls or exits, it's gone. If the throw happened before `trace.flush()` (on the `/ask` path only — `/research` never flushes anything, see `05-live-progress-panel.md`), the trace table has no record either — so a failed turn can leave **zero durable evidence**.

**The silent memory swallow — not even a sentence.** `session.ask()` wraps the episodic-memory write in an empty catch (`src/session.ts:686-690`):

```
  src/session.ts:686   try {
  :687     await memory.remember({ conversationId, question, answer });
  :688   } catch {
  :689     // swallow: memory is best-effort, the turn already succeeded
  :690   }
```

This is the *opposite* end of the spectrum from stdout — not even an unstructured line. The decision is correct (a memory failure must not lose the user's answer), but the observability cost is total: episodic memory can silently stop working and nothing — not stdout, not the trace, nothing — records that it did.

**New evidence for the same thesis: three shipped concurrency bugs, each diagnosable only by watching the process hang, and none of the fixes logs anything.** `64f822f`, `9c1b1e6`, and `26f0e4b` fixed a freeze on `/exit`, a dead Ctrl+C handler, and swallowed flow-promise rejections respectively (full case study in `audit.md` lens 7). What ties them to this file specifically: fixing a hang is exactly the scenario where stdout-as-the-only-log hurts most — a hung process, by definition, hasn't printed anything to explain why it's hung. `session.ts`'s exit path shows the fix pattern plainly (`src/session.ts:876-881`):

```
  src/session.ts:876   async close(): Promise<void> {
  :877     await Promise.race([
  :878       pool.end(),
  :879       new Promise<void>(resolve => setTimeout(resolve, 1000)),
  :880     ]);
  :881   },
```

Read what this *doesn't* do. If `pool.end()` is the slow branch and the timeout wins the race, nothing logs "pool.end() did not resolve within 1000ms — forcing exit." The process still exits cleanly (the bug is fixed), but the *evidence* that would tell you next time — is the pool actually hanging, or did it just take 1001ms under load? — was never captured. Same shape in `chat.tsx`'s Ctrl+C handler (`:379-383`) and the flow-rejection handlers (`:184-188`, `:309-313`, `:350-354`): each converts a silent hang into a *handled* one, and none converts it into a *logged* one.

#### Move 2 variant — the load-bearing skeleton

What's *missing* that a structured-logging layer would add, named by what its absence breaks:

1. **Severity levels** — without `info`/`warn`/`error`, you can't filter noise from signal; every line is equal weight. (absent everywhere)
2. **Structured fields** — without `{ path, chunks, app_id }`, you can't query "all indexing runs for app_id=laptop"; you'd grep prose. (`index-cmd.ts:38`)
3. **A durable sink** — without shipping logs somewhere, they die with the terminal; the swallowed memory error (`session.ts:66`) is the proof.
4. **A correlation id in the log line** — the trace table *has* `conversation_id`, but the stdout surface doesn't carry it, so you can't tie a printed line back to a turn.

The honest framing: at buffr's scope — single-device, a human at the terminal — stdout is a *defensible* choice, not negligence. The human watching the terminal *is* the log sink. The pattern earns a file because the moment buffr runs unattended, every item above flips from "fine" to "blind spot," and the swallowed memory error is already a blind spot today.

#### Move 3 — the principle

**A log line is only as useful as the fields it carries and the sink it survives in.** Printing a sentence to stdout answers "is it running" for a human watching live; it answers nothing for a human debugging after the fact. The general rule: if an operation knows a fact worth acting on (chunk count, error cause, `app_id`), the log should carry it as a *field*, not bury it in prose or drop it entirely.

## Primary diagram

```
  stdout-as-only-log — the surfaces, ranked by evidence left

  surface                    on success        on failure          durable?
  ─────────────────────────  ────────────────  ──────────────────  ────────
  index-cmd.ts:38            "indexed X"       (throws, uncaught)  no
  eval-cmd.ts:33-35          P@1 / R@3 lines   (throws, uncaught)  no
  chat.tsx (6+ .then sites)  (trace row, /ask  render "error:…"    no (scroll)
                              only)
  session.ts:686-690 memory  (trace row)       SILENT — nothing    no — none
  session.ts:876-881 close   (exits cleanly)   race vs timeout,    no — the
  (pool.end on exit)                            SILENT if it fires  timeout path
                                                                     logs nothing

       ▲                                          ▲
   the ONE good surface is elsewhere:         the worst case:
   agents.messages, /ask only (01-, 02-)      a swallowed error
   — structured, durable, queryable           or a masked hang,
                                               both with zero evidence
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

You wouldn't, from stdout — the print fires on completion, not correctness (`index-cmd.ts:38`). The fix is a structured line carrying the chunk count and `app_id` the operation already has, so "indexed X → 0 chunks" is visibly wrong. **Anchor:** the field-less `process.stdout.write` at `index-cmd.ts:38` — completion is not correctness.

**Q: What's the single worst observability hole in the repo?**

Two contenders, and the honest answer names both. The empty catch on the memory write (`session.ts:686-690`) is the only place a real state-change failure leaves *zero* evidence by design — not a stdout line, not a trace row, nothing. The decision to swallow is right (don't lose the user's answer), but the *silence* is the bug: it should persist an `error` row, which the trace sink already handles. The newer contender is structural rather than a single line: `/research`/`/investing`'s Analyzer/Teacher calls never reach a trace at all (`audit.md` lens 1), so the *entire pipeline* has the memory-swallow's blind spot, not just one write. **Anchor:** `catch { // swallow }` at `session.ts:688`.

**Q: You shipped a fix for a hang on `/exit`. How would you know if the same class of bug came back?**

You wouldn't, today — and that's the honest, slightly uncomfortable answer. `session.ts:876-881` races `pool.end()` against a 1-second timeout, so the process always exits, but neither branch of the race logs which one won. A future hang in a *different* cleanup call would look identical: the CLI takes about a second longer to exit than usual, with nothing printed to say why. The fix closes the symptom without instrumenting the cause. **Anchor:** the bare `Promise.race([pool.end(), timeout])` at `session.ts:877-880` — no branch is logged.

## See also

- `01-full-signal-trajectory-capture.md` — the structured surface this one is the inverse of, for `/ask`.
- `04-eval-numbers-as-quality-signal.md` — the eval stdout, treated as its own signal.
- `05-live-progress-panel.md` — the live-only signal `/research`/`/investing` have instead of a trace; this file is what's left when neither a trace nor a progress panel exists.
- `audit.md` lens 3 (structured logs), lens 6 (debugging boundaries), lens 7 (Case study B — the concurrency fixes), lens 8 (red-flag rank 4 & 5).
- Cross-guide: `study-testing` (the eval as a regression guard, not a log).
