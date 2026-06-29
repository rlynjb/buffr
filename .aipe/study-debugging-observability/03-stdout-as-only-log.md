# Stdout-As-Only-Log

**Industry names:** print-debugging · console logging · unstructured stdout.
**Type:** Project-specific (the deliberate *absence* of a logging layer — a
pattern worth naming because what's missing is the lesson).

---

## Zoom out, then zoom in

You know the difference between `console.log('here', x)` and a real logger with
levels, JSON, and a request id? This repo is firmly on the `console.log` side —
and on purpose, for now. Outside the trace sink, every signal the repo produces is
a plain line written to `process.stdout`. No level, no structure, no correlation
id. For a single-user laptop tool you run by hand, that's the right amount of
machinery. The pattern is worth a file because knowing *why* it's enough — and the
exact moment it stops being enough — is the actual skill.

Where it sits:

```
  Zoom out — the two logging worlds in this repo

  ┌─ UI / CLI layer ──────────────────────────────────────────┐
  │  index-cmd.ts → stdout "indexed X"   ◄─┐                   │
  │  eval-cmd.ts  → stdout "P@1 / R@3"   ◄─┤ ★ THIS CONCEPT ★  │ ← we are here
  │  chat.tsx     → Ink renders error   ◄─┘  (ephemeral lines) │
  └──────────────────────────┬─────────────────────────────────┘
                             │  (no shared sink, no correlation)
  ┌─ Trace sink ────────────▼─────────────────────────────────┐
  │  SupabaseTraceSink → agents.messages  (the OTHER world:    │
  │  typed, durable, correlated — see file 01)                │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **stdout as the only log** — diagnostic output is human-
readable text on the terminal, gone when the terminal scrolls. The question it
answers (and where it falls short): *when something goes wrong in a CLI run, what
can I filter, query, or correlate?* Answer today: nothing — you read what scrolled
by.

## Structure pass

Three call sites, one axis: **can this output be filtered or correlated later?**
The answer is "no" at every site, but the *kind* of no differs.

```
  Axis — "queryable / correlatable later?" — across the three sites

  ┌─ index-cmd ──────┐  ┌─ eval-cmd ───────┐  ┌─ chat.tsx (Ink) ──┐
  │ "indexed <path>" │  │ "P@1 .. R@3 .."  │  │ "error: <msg>"    │
  │ stdout.write     │  │ stdout.write     │  │ React state → frame│
  └──────┬───────────┘  └──────┬───────────┘  └──────┬────────────┘
         │ no level            │ no level            │ no level
         │ no structure        │ structured numbers  │ caught per-turn
         │ no corr id          │ but printed, not    │ NOT sent to sink
         ▼                     ▼ stored              ▼
       lost on scroll        lost on scroll        lost on next render
```

The seam that *doesn't exist* is the load-bearing observation: there's no logger
abstraction between these call sites and the terminal. Compare file 01, where the
`CapabilityTraceSink` seam turns events into durable rows. Here the "sink" is
`process.stdout` directly — no contract, no place to add levels or a correlation
id without touching every call site.

## How it works

### Move 1 — the mental model

It's `console.log`, formalized as `process.stdout.write` (which doesn't append a
newline, so each site adds `\n` itself). The shape: compute something, write a
line, move on. Nothing accumulates, nothing is addressable.

```
  The pattern — fire-and-forget lines

  do work ──► format a line ──► process.stdout.write(line + '\n') ──► gone on scroll
              │                                                       │
              └── no level tag, no key=value, no conversation_id ─────┘
```

The kernel: **a string and a write call.** That's it — which is the point. There's
no level filter to drop, no formatter to swap, no correlation id to thread. The
absence *is* the structure.

### Move 2 — the step-by-step walkthrough

**The use case.** Two one-shot CLIs you run by hand, plus the chat's error path.

**Part 1 — `index-cmd` prints progress, one line per file.** You run
`npm run index -- a.md b.md` and watch lines appear.

```ts
// src/cli/index-cmd.ts:22-26
for (const path of paths) {
  const text = await readFile(path, 'utf8');
  await indexDocumentRow(pool, cfg.appId, pipeline, { id: basename(path), text, sourcePath: path });
  process.stdout.write(`indexed ${path}\n`);   // ← the only signal this loop emits
}
```

What this gives you: live "it's making progress." What it doesn't: no count, no
duration, no level, and if `indexDocumentRow` throws, the error is an *unhandled
rejection* that crashes the script — there's no `catch` writing an error line.
Boundary condition: a partial run (3 of 5 files indexed, then a throw) leaves you
reading stdout to figure out where it stopped.

**Part 2 — `eval-cmd` prints the only numbers in the repo.** Structured numbers,
but printed, not stored.

```ts
// src/cli/eval-cmd.ts:24-33
for (const { query, relevant } of queries) {
  const hits = await pipeline.query(query, K);
  const docs = [...new Set(hits.map((h) => String(h.meta.docId)))];
  const p = scorePrecisionAtK(docs, new Set(relevant), 1).score;
  const r = scoreRecallAtK(docs, new Set(relevant), K).score;
  p1 += p; rk += r;
  process.stdout.write(`${query.padEnd(44)} P@1 ${p.toFixed(2)}  R@${K} ${r.toFixed(2)}\n`);
}
process.stdout.write(`\nmean P@1 ${(p1 / queries.length).toFixed(2)}  mean R@${K} ...\n`);
```

These are real metrics (precision/recall) — but they land on the terminal, not in
a table, so there's no run-over-run trend. file 04 takes this up as a *quality
signal*; here the point is only that the *transport* is stdout, so the number
exists for exactly as long as the terminal scrollback.

**Part 3 — Ink catches per-turn errors and renders them as a turn.** The chat
doesn't crash on an error; it shows it and keeps going.

```ts
// src/cli/chat.tsx:27-34
try {
  const answer = await session.ask(q);
  setTurns((t) => [...t, { role: 'buffr', text: answer }]);
} catch (err) {
  setTurns((t) => [...t, { role: 'buffr', text: `error: ${(err as Error).message}` }]);
} finally {
  setBusy(false);
}
```

```
  Layers-and-hops — an error's two possible fates, neither correlated

  ┌─ Ink turn ──┐  throws   ┌─ catch ──────────┐  setTurns  ┌─ screen ─────┐
  │ session.ask │ ────────► │ "error: <msg>"   │ ─────────► │ one red turn │
  └─────┬───────┘           └──────────────────┘            └──────────────┘
        │ if the error happened INSIDE the agent run, the sink
        │ already wrote an `error` row (file 01) — but the Ink
        ▼ message and that row share NO id; you can't join them
  (uncorrelated: screen text ≠ the messages row)
```

The boundary condition worth naming: an error *inside* the agent run gets written
to `agents.messages` as an `error` row by the sink (file 01) *and* surfaces on
screen here — but the two are uncorrelated. The screen shows `err.message`; the
row has its own. There's no shared id to join "what the user saw" to "what the
trace recorded."

#### Move 2.5 — current state vs what it grows into

What stdout-only is missing, and the trigger that makes each one matter:

```
  Now (stdout-only)            →   When you'd add it
  ─────────────────────────────────────────────────────────
  no level (info/warn/error)   →   output collected by a tool
                                   that filters by severity
  no structure (free text)     →   you need to query logs, not eyeball them
  no correlation id            →   a failure spans CLI + sink and you
                                   must join "what I saw" to "what's stored"
  no aggregation               →   "is it failing MORE lately?" (→ metrics, file 04)
```

Note the irony: the repo already *has* the richer world (typed, durable,
correlated events in `agents.messages`, file 01) — but only the agent run feeds
it. The CLIs and Ink errors never reach that sink. The cheapest upgrade isn't a
logging library; it's routing CLI signals into the same `messages`/events store so
they share the `conversation_id` correlation key.

#### Move 3 — the principle

Match the logging machinery to who reads it. A human watching a terminal needs a
readable line; a machine collecting logs across runs needs levels, structure, and
a correlation id. This repo's reader is a human at a terminal, so stdout is
correct — and naming the trigger that flips that ("the moment a machine, not a
person, reads the output") is more useful than reflexively reaching for a logger.

## Primary diagram

The whole logging picture — the thin world and the rich world side by side.

```
  Stdout-as-only-log vs the trace sink — two worlds, one repo

  ┌─ THIN world: stdout (this file) ──────────────────────────────────┐
  │  index-cmd.ts:25  → "indexed <path>\n"                             │
  │  eval-cmd.ts:31   → "<query> P@1 .. R@3 ..\n"                      │
  │  chat.tsx:31      → Ink turn "error: <msg>"                        │
  │  properties: no level · no structure · no corr id · scroll-gone    │
  └───────────────────────────────────────────────────────────────────┘
                       (no shared sink, no join key)
  ┌─ RICH world: trace sink (file 01) ────────────────────────────────┐
  │  SupabaseTraceSink → agents.messages                              │
  │  properties: typed events · durable rows · conversation_id corr ·  │
  │  ordered replay (file 02)                                          │
  └───────────────────────────────────────────────────────────────────┘
   upgrade path: route the THIN signals into the RICH store → one key
```

## Elaborate

"Print debugging" is the oldest observability tool and still the right one when a
human is the consumer and the run is short. The structured-logging discipline
(levels, JSON lines, correlation ids — the twelve-factor "logs as event streams"
idea) earns its weight when logs are *collected* and *queried* by something other
than a person. This repo sits before that line deliberately: single user, single
device, runs you start by hand.

Connects to: `01-full-signal-trajectory-capture.md` (the rich world this contrasts
with — the repo already has structured logging *for the agent run*, just not for
the CLIs), `04-eval-numbers-as-quality-signal.md` (the eval numbers that flow
through this stdout transport), and the audit's lens 3 (structured-logs-and-
correlation) for the full verdict including the redaction gap.

## Interview defense

**Q: Your CLIs just `process.stdout.write` — no logger. Defend it.** The consumer
is a human at a terminal running a one-shot command. Levels, JSON, and correlation
ids earn their weight when a *machine* collects and queries logs across runs —
that's not this. Adding a logging library here would be machinery with no reader.
What I'd watch for is the trigger to flip: the moment output is collected by
something that filters or joins it, stdout stops being enough.

```
  human reads terminal → stdout is right
  machine collects logs → need level + structure + corr id
```

**Q: An error happens during a chat turn — where does it go?** Two places that
don't talk to each other. Ink catches it and renders `error: <msg>` as a turn
(`chat.tsx:31`), so the chat survives. If the error was *inside* the agent run, the
trace sink also wrote an `error` row to `agents.messages` (file 01). But the screen
message and the row share no id — I can't join "what the user saw" to "what the
trace stored." The cheapest fix isn't a logger, it's routing the CLI/UI signals
into the same store so they inherit the `conversation_id` correlation key.

```
  screen "error: X"   ⟂   messages row {error}   ← no shared id today
```

**Q: What's the one upgrade you'd make first?** Correlation, not levels. The repo
already has a durable, typed, correlated store for agent events. The gap is that
the CLIs and Ink errors bypass it. Route them through it and you get the
correlation id for free — that's higher leverage than bolting a logging library
onto stdout.

## See also

- `01-full-signal-trajectory-capture.md` — the structured, durable, correlated
  world this file contrasts against.
- `04-eval-numbers-as-quality-signal.md` — the eval numbers carried over this
  stdout transport.
- `audit.md` lens 3 (structured-logs-and-correlation), incl. the redaction gap.
