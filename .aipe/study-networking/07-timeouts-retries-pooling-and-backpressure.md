# Timeouts, Retries, Pooling & Backpressure

**Network failure-handling & overload control** · Industry standard

## Zoom out, then zoom in

Verdict first, no flinching: **buffr has none of its own.** No timeout is
constructed at any call-site. No retry loop. No backoff, no jitter. The pool is
stock defaults. No backpressure because there's no concurrency to push back on.
This isn't a list of bugs — it's an accurate description of a single-user CLI
that does one thing and exits. This file teaches each mechanism as the pattern
it is, then shows precisely where its absence bites and where it genuinely
doesn't matter.

```
  Zoom out — the resilience layer (mostly empty)

  ┌─ Provider layer ────────────────────────────────────────────────┐
  │   Postgres :5432            Ollama :11434                        │
  └──────┬──────────────────────────────┬──────────────────────────┘
  ┌─ Resilience layer ──────────────────────────────────────────────┐
  │   timeouts: NONE (repo)     retries: NONE     backoff: NONE      │ ★ THIS FILE ★
  │   pool tuning: NONE         backpressure: N/A (no concurrency)   │
  └──────┬──────────────────────────────┬──────────────────────────┘
  ┌─ Service layer ─────────────────────────────────────────────────┐
  │   createPool(connStr)       providers accept AbortSignal —       │
  │   (no timeouts set)         but buffr never passes one           │
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in: this layer answers "*what happens when the network is slow, flaky, or
overloaded?*" buffr's answer today is "it blocks, and if it errors the turn shows
the error." For a human running `npm run chat` and watching the terminal, that's
livable — and `chat` softens it slightly: a thrown turn is caught by the Ink
handler and rendered as `error: ...` instead of killing the process
(`src/cli/chat.tsx:30-34`), so the session survives a bad turn. But a *hang* (no
throw) still freezes the whole session, because there's still no timeout. For
anything unattended, a timeout is the first thing you'd add.

## Structure pass

**Layers.** Call-site → provider/pool → transport → network. Trace *failure* —
where does a slow/failed call get contained — down.

**Axis — "where does a slow or failed call get contained?"**

```
  One question down the resilience stack

  "where is a hang or failure contained?"

  ┌─ call-site (session.ask) ───────────┐  → no TIMEOUT. a try/catch exists
  │  await agent.answer(question)        │     (Ink renders the throw) but a
  └──────────────────────────────────────┘     hang has no throw → blocks forever
      ┌─ provider / pool ───────────────┐  → providers ACCEPT a signal but
      │  GemmaProvider / pg.Pool         │     buffr passes none; pool has no
      └──────────────────────────────────┘     connectionTimeout
          ┌─ transport (aptkit) ────────┐  → fetch without a signal = no
          │  fetch(... no signal ...)    │     timeout; waits on the OS
          └──────────────────────────────┘
              ┌─ network ───────────────┐  → only the OS/TCP keepalive ever
              │  TCP / OS                │     gives up, on its own slow clock
              └──────────────────────────┘

  failure is contained NOWHERE in the repo — it propagates to the top and exits
```

**Seam.** The seam where every one of these mechanisms *would* attach is the
`AbortSignal`. aptkit's providers and pg both honor cancellation/timeout if you
hand them one. buffr never constructs an `AbortController`. So the resilience
seam exists, fully wired on the dependency side — and buffr leaves it empty.

## How it works

### Move 1 — the mental model

These four mechanisms are all answers to "the network is not cooperating." A
timeout bounds *how long you wait*. A retry *tries again*. Backoff+jitter
*spaces the retries* so you don't stampede. Backpressure *slows the producer*
when the consumer can't keep up. You've used the first two in any robust `fetch`
wrapper.

```
  The resilience kernel — four guards on one call

  call ──► [ timeout? ] ──exceeds──► abort + maybe retry
              │ within
              ▼
          [ ok? ] ──no──► [ retries left? ] ──yes──► wait backoff+jitter ──┐
              │ yes              │ no                                       │
              ▼                  ▼                                          │
           result            give up ◄──────────────────────────────────────┘

  buffr implements NONE of these guards — the call just runs to completion
  or throws, and the throw isn't caught either.
```

### Move 2 — each mechanism, and buffr's status

**Timeout — bound the wait. Status: absent.** A timeout fires an
`AbortController` after N ms so a hung call returns control. aptkit's transports
accept a `signal`; buffr never creates one. Concretely: if Ollama hangs loading
a 9B model, the `fetch` in `/api/chat` waits on the OS's default socket timeout
(minutes), and the whole `chat` session sits frozen — the Ink input never comes
back because `session.ask()` never resolves, so you can't even type `/exit`. The
fix is one `AbortSignal.timeout(ms)` passed through `agent.answer()` — the seam
is ready; the call isn't using it.

```
  Timeout — the guard buffr doesn't set

  ┌─ session ─┐ await answer()  ┌─ Ollama (hung) ─┐
  │ turn never│ ───────────────► │ model loading...│
  │ resolves  │  (no signal)     │ ...still...     │
  └─────────┘                    └─────────────────┘
       ▲
       └─ with AbortSignal.timeout(30_000) this would throw after 30s (and Ink
          would render it as an error turn). without it, the OS socket timeout
          (minutes) is the only backstop and the whole session is frozen.
```

**Retry — try again on transient failure. Status: absent (don't confuse with
Gemma's nudge).** There's a thing in aptkit's Gemma provider called a "retry" —
but it re-prompts the model when it returns *malformed JSON for a tool call*. It
is **not** a network retry; a dropped connection or a 503 is not retried, it
throws. buffr adds no retry of its own. In `chat`, a thrown turn surfaces as an
`error:` line and the human just re-asks on the next turn — *that* is the retry.
The one try/catch buffr does add is around the *memory* write (`src/session.ts:65-69`):
it's failure *isolation*, not retry — a memory-embed failure is swallowed so the
turn still returns the answer the user already has. Worth naming both as
deliberate non-choices.

```
  Two things called "retry" — only one exists, and it's not network

  GEMMA JSON NUDGE (exists, aptkit)      NETWORK RETRY (absent)
  ┌──────────────────────────────┐       ┌──────────────────────────┐
  │ model returned bad tool JSON  │       │ connection dropped / 503  │
  │ → re-ask with corrective hint │       │ → (nothing) throws + exits│
  └──────────────────────────────┘       └──────────────────────────┘
  application-level correctness          transport-level resilience
```

**Backoff + jitter — space the retries. Status: N/A.** No retry means no backoff
to configure. (If retries were added, exponential backoff with jitter would be
the standard partner — but that's future work, not a gap in current code.)

**Connection pool tuning — bound the connections. Status: stock defaults.**
`createPool` sets only the connection string (`src/db.ts:5`). So: `max` = pg
default (10), no `connectionTimeoutMillis` (a hung *connect* blocks forever), no
`idleTimeoutMillis`, no `statement_timeout` (a runaway query never gets killed
by the client). For one user this is fine; the one I'd actually add is
`connectionTimeoutMillis`, so a dead DB host fails fast instead of hanging.

```
  pg.Pool defaults buffr relies on

  max ................ 10        (fine for single user)
  connectionTimeout .. ∞         ← the one worth setting: dead host = hang
  idleTimeout ........ default   (process is short-lived anyway)
  statement_timeout .. none      ← a runaway query isn't client-killed
```

**Backpressure — slow the producer when the consumer lags. Status: N/A.**
Backpressure matters when you have a fast producer and a bounded consumer (a
queue filling up). buffr's CLIs are sequential — `index` embeds and inserts one
document at a time in a `for` loop, awaiting each. There's no concurrency, no
queue, nothing to overflow. The `for` loop *is* the flow control: it can't get
ahead of itself. So backpressure isn't missing — it's structurally unnecessary.

```
  index-cmd's sequential loop = built-in flow control

  for (const path of paths) {
    await indexDocumentRow(...)   ← awaits each fully before the next
  }                                  no fan-out ⇒ no queue ⇒ no backpressure
```

### Move 2 variant — the load-bearing absence

If you added exactly one thing, it'd be a **timeout via `AbortSignal`**, because
it's the guard whose absence has the worst failure mode: an indefinite hang with
no feedback. Retries are second (and need a timeout first to be meaningful).
Pool `connectionTimeoutMillis` is third. Everything else (backoff, jitter,
backpressure) is either downstream of those or structurally unnecessary here.
Ranking the absences *is* the lesson — they're not equally missing.

### Move 3 — the principle

Resilience mechanisms are insurance: you pay complexity now against failures
later, and the right amount depends on who's watching. An interactive CLI has a
human as its backstop — they see the hang, they Ctrl-C, they re-run. That human
*is* the timeout and the retry. The moment buffr runs unattended (a cron index,
a server endpoint), the human disappears and every absent guard becomes a real
gap. Knowing which guards you've delegated to the operator — and which you'd add
first when that changes — is the actual skill.

## Primary diagram

The resilience layer, every mechanism, buffr's status on each.

```
  buffr resilience scorecard

  mechanism          status          what bites / why it's fine
  ─────────────────────────────────────────────────────────────────────
  timeout            ✗ absent        hung Ollama/DB blocks forever (worst)
  retry (network)    ✗ absent        transient drop → throw + exit; rerun=retry
  backoff + jitter   — N/A           no retries to space
  pool: max          ◑ default 10    fine for single user
  pool: connTimeout  ✗ absent        dead DB host hangs (add this 2nd)
  pool: stmtTimeout  ✗ absent        runaway query not client-killed
  backpressure       — N/A           sequential for-loops, no queue to overflow
  ─────────────────────────────────────────────────────────────────────
  the seam for all guards = AbortSignal, which buffr never constructs
```

## Implementation in codebase

**Use cases.** The absence is uniform: no call-site in `src/cli/*` wraps its
awaits in a timeout, retry, or try/catch. The pool is built bare in `src/db.ts`.

**Code side by side.** The pool's missing tuning:

```
  src/db.ts  (lines 4–6)

  return new pg.Pool({ connectionString: databaseUrl });
                       │
                       └─ no connectionTimeoutMillis → a dead DB host makes
                          the first query hang on the OS connect timeout.
                          no statement_timeout → a slow query isn't killed.
                          this is the whole resilience config: empty.
```

The unguarded call-site — now a per-turn `ask()`:

```
  src/session.ts  (lines 60–70, the ask() turn)

  await persistMessage(pool, conversationId, 'user', question);
  const answer = await agent.answer(question);   ← no timeout, no AbortSignal
  await trace.flush();                            ← no timeout either
  try { await memory.remember(...); }             ← the ONE guard: best-effort
  catch { /* swallow */ }                          ← memory failure ≠ lost answer
  return answer;
          │
          └─ no AbortSignal anywhere on agent.answer / flush. aptkit's providers
             would honor one (their transports take `signal`) — buffr just never
             makes a controller to pass. the only try/catch isolates the memory
             write, NOT the network calls. the timeout seam is open; nothing's
             plugged in. (a thrown turn is caught one layer up, in chat.tsx:30-34,
             and rendered as an error line — but a hang never throws.)
```

The one *real* "retry" — and why it's not a network retry:

```
  @rlynjb/aptkit-core .../provider-gemma  (dependency, for contrast)

  // On a retry, append a corrective nudge so Gemma fixes its JSON.
  // → re-prompts on MALFORMED TOOL-CALL JSON, not on network failure.
  //   a dropped socket or HTTP 503 is NOT retried — it throws.
```

## Elaborate

The canonical resilient-client recipe is: timeout every call, retry idempotent
failures with exponential backoff + jitter, cap total attempts, and shed load
under pressure (backpressure / circuit breaker). buffr implements the empty
version of this because its execution model — one short-lived, human-supervised
process — makes the operator the resilience layer. The pattern to internalize:
resilience requirements come from the *execution context*, not the code. Same
code, run unattended at scale, would need every guard here. That context shift
is exactly what `study-system-design` and `study-distributed-systems` reason
about.

## Interview defense

**Q: What happens if Ollama hangs?**

```
  await agent.answer() ──► fetch (no signal) ──► waits on OS socket timeout
       blocks the CLI for minutes; no app-level timeout fires
```

Answer — honest: "It hangs. There's no `AbortSignal` on the call, so the `fetch`
waits on the OS socket timeout — minutes. For an interactive CLI the human
Ctrl-Cs; for anything unattended it's a real gap. The fix is one
`AbortSignal.timeout()` passed through — aptkit's transport already accepts a
signal, buffr just never makes one. And because `chat` is long-lived, that hang
freezes the whole session, not just one command." Anchor: `src/session.ts:62`,
`src/db.ts:5`.

**Q: Do you retry failed network calls?**

Answer: "No network retries. There's a thing in the Gemma provider called retry,
but it re-prompts on malformed tool-call JSON — application correctness, not
transport. A dropped connection or a 503 throws and exits. Re-running the command
is the retry — in `chat`, just re-asking on the next turn. If this went
unattended, network retry-with-backoff is the second thing I'd add, after
timeouts." Anchor: aptkit Gemma provider behind `src/session.ts:46`.

**Q: Why no backpressure?**

Answer: "Nothing to apply it to. `index-cmd` is a sequential `for await` loop —
one document fully processed before the next. No fan-out, no queue, nothing to
overflow. The loop is the flow control." Anchor: `src/cli/index-cmd.ts:22-26`.

## Validate

1. **Reconstruct:** the four-guard kernel — timeout, retry, backoff+jitter,
   backpressure — and which buffr has (none).
2. **Explain:** why is Gemma's "retry" not a network retry? (re-prompts on bad
   JSON, not on transport failure.)
3. **Apply:** the DB host is dead. Trace what happens with stock pool defaults.
   (first query hangs on OS connect timeout; no `connectionTimeoutMillis` to
   fail fast — `src/db.ts:5`.)
4. **Defend:** is "no resilience guards" the right call today, and what's the
   first one you'd add? (right for human-supervised CLI; add `AbortSignal`
   timeout first — `src/session.ts:62`. A hang now freezes the long-lived
   session, not just one command.)

## See also

- `03-tcp-udp-connections-and-sockets.md` — the pool whose tuning is absent.
- `05-http-semantics-caching-and-cors.md` — the status branch with no retry.
- `06-websockets-sse-streaming-and-realtime.md` — the blocking await with no timeout.
- `08-networking-red-flags-audit.md` — these absences ranked by consequence.
- `study-distributed-systems` — resilience when the operator-as-backstop disappears.

Updated: 2026-06-24 — Repointed the unguarded call-site off the deleted `ask-cmd.ts` onto the per-turn `src/session.ts` `ask()` (lines 60-70, 62), re-verified the still-true no-timeout/no-retry/no-AbortSignal verdict against current `src/`, and sharpened the failure mode for the long-lived session (a hang now freezes the whole `chat` session, not one command). Noted the two guards that DO exist and aren't network resilience: the Ink-level try/catch that renders a thrown turn as an error line (`src/cli/chat.tsx:30-34`), and the best-effort memory-write try/catch (`src/session.ts:65-69`).
