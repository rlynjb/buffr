# 05 · Memory: Stack, Heap, GC, and Lifetimes

**Allocation, heap pressure, garbage collection, and object lifetimes** · *Industry standard*

---

## Zoom out, then zoom in

Where does buffr's memory go, and what holds it? In the **batch** CLIs three
allocations dominate and all are short-lived because the process is: the **whole
file read into a string** (`index-cmd.ts:23`), the **embedding arrays** (768
floats each, serialized to a text literal), and the **`pending[]` promise array**
that grows for one agent run and drops at flush. The **chat** process changes the
calculus for one of them and adds a new one: `pending[]` resets per turn (flushed
each `ask`), but the React **`turns[]` array** (`chat.tsx:11`) grows for the
whole session and is never trimmed — in a long-lived process that's the
allocation to watch. There's no manual memory management — V8's GC reclaims
everything — but the *shapes* matter, because some scale with input and some
(now) scale with session length.

```
  Zoom out — where memory lives

  ┌─ Node process heap (V8, GC-managed) ─────────────────────────┐
  │                                                              │
  │  ┌─ short-lived, per-op ──────────────────────────────────┐ │
  │  │  whole file string · embedding number[] · SQL params   │ │ ← here
  │  └────────────────────────────────────────────────────────┘ │
  │  ┌─ lives a whole run ────────────────────────────────────┐ │
  │  │  pending[] promise array · the pg.Pool + its clients   │ │
  │  └────────────────────────────────────────────────────────┘ │
  └──────────────────────────────────────────────────────────────┘
       │ when the process exits, the OS reclaims ALL of it anyway
```

Zoom in: the concept is **allocation lifetime** — when an object is born, what
keeps it alive (references), and when GC can reclaim it. In a short-lived CLI,
process exit is the ultimate "free," which changes how much the GC even matters.

---

## Structure pass

**Layers, by lifetime:**

```
  Lifetime          What lives that long          Reclaimed by
  ────────────────  ───────────────────────────   ──────────────────────
  stack frame       loop vars, function args      automatic (frame pops)
  one I/O op        file string, embedding array  GC after last reference
  one turn          pending[] (flushed each ask)  GC after flush
  whole session     turns[] (chat), pg.Pool,      GC at /exit, or process exit
  (chat) / process  agent, conversationId
```

**Axis traced — "what keeps this alive?"**

```
  "what reference is preventing GC of this object?"

  ┌──────────────────────────────────────────────┐
  │ file string  → the `text` const in the loop;  │  freed next iteration
  │                released when loop reassigns    │  (last ref drops)
  └──────────────────────────────────────────────┘
      ┌──────────────────────────────────────────┐
      │ embedding    → held inside the upsert call;│  freed after upsert
      │                gone once the row is written │  returns
      └──────────────────────────────────────────┘
          ┌──────────────────────────────────────┐
          │ pending[]    → sink array; held one    │  ← reset each turn
          │                turn, dropped at flush   │     (flushed per ask)
          └──────────────────────────────────────┘
              ┌──────────────────────────────────┐
              │ turns[] (chat) → React state array │  ← held the WHOLE
              │                  appended every turn│     SESSION, never trimmed
              └──────────────────────────────────┘
```

The answer that matters has shifted with the chat process. `pending[]` is no
longer the longest-lived growing allocation — it's flushed and dropped each
turn. The longest-lived growing one is now `turns[]` (`chat.tsx:11,25,29`): every
exchange appends a `{role, text}` object and nothing ever removes them, so it
grows for the entire session. Each entry is small, but in a long-lived process
"small and unbounded" is the classic slow leak shape — see Elaborate.

**Seams:**

- **stack ↔ heap.** Primitives and references sit on the stack frame; the
  strings, arrays, and objects they point to live on the heap. The `for` loop
  variable `path` is on the stack; the file contents it reads are on the heap.
- **alive ↔ collectable.** An object becomes collectable the instant its last
  reference drops. For `pending[]` that's after `flush()` each turn; for
  `turns[]` it's never until `/exit` — the React array holds every entry for the
  session's life.

---

## How it works

### Move 1 — the mental model

You know how in React a component's local `const data = await res.json()` is
held only while that function runs, then becomes garbage once the function
returns and nothing else points at it? Heap lifetime in buffr is the same rule
applied to file strings and embedding arrays — they live exactly as long as
something references them, and the GC sweeps them once nothing does.

```
  Object lifetime — born, referenced, collectable

   allocate ──► referenced (alive) ──► last ref drops ──► GC reclaims
      │              │                       │                 │
   readFile      const text            loop reassigns      heap freed
   embed()       in upsert call        upsert returns      (eventually)

   the GC runs on ITS schedule, not yours — "collectable" ≠ "freed now"
```

### Move 2 — the allocations, one at a time

**The stack: loop variables and call frames.** Every function call pushes a
frame holding its locals. The `for (const path of paths)` loop
(`index-cmd.ts:22`) and the `for (const c of chunks)` loop
(`pg-vector-store.ts:43`) keep one small frame each; the recursion-free,
straight-line nature of buffr means the stack stays shallow. No deep recursion,
no stack-overflow risk anywhere.

**The heap, allocation #1 — whole file as a string.** `readFile(path, 'utf8')`
(`index-cmd.ts:23`) loads the *entire* file into one heap string before any
chunking happens. For the markdown corpus this targets, that's kilobytes —
trivial. But it's an unbounded allocation: a 500MB file becomes a 500MB heap
string, and `readFile` would buffer the whole thing before returning. **Not yet
exercised:** streaming. → `06` covers why streaming would change this.

```
  Whole-file read — the allocation shape

  disk file ──readFile──► ┌─ one heap string ─┐ ──► pipeline.index chunks it
   (any size)             │ ENTIRE file here  │
                          └───────────────────┘
                          peak heap = file size, all at once
```

**The heap, allocation #2 — embedding arrays.** Each chunk gets a 768-element
`number[]` from Ollama, then `toVectorLiteral` (`pg-vector-store.ts:15`) joins
it into a `[0.1,0.2,...]` *string* for the SQL parameter. So momentarily you hold
both the array *and* its string serialization. 768 doubles ≈ 6KB per array; the
string is similar. Per chunk, freed after the insert. Bounded and small.

**The heap, allocation #3 — the `pending[]` promise array (per turn).** During a
turn, `SupabaseTraceSink.pending` (`supabase-trace-sink.ts:50`) grows by one
promise per emitted event — now potentially more, since all 6 event types persist
(`03`). Each promise retains its closure: the `pool`, the `conversationId`, the
event content. The array stays alive until `flush()` resolves it. Critically, in
chat the sink is built once per session and `pending[]` is **not** reset between
turns — it keeps accumulating settled promises across every `ask()` because
nothing clears it after `flush()`. The promises are resolved (so their closures
*can* be collected), but the array slots themselves grow unboundedly with turn
count. Small, but it's a second session-scoped growth alongside `turns[]`.

```
  pending[] lifetime — accumulates across turns in a held session

  turn 1: push p1 p2 ─► flush ✓   turn 2: push p3 p4 ─► flush ✓   ...
            │                                │
            └─ array never cleared ──────────┘ → grows with #turns × #events
               (resolved promises are light, but the slots persist)
```

**The heap, allocation #4 — `turns[]`, the session-scoped React array.** This is
the one the long-lived process introduces. `chat.tsx:11` holds
`useState<Turn[]>`; every exchange appends two entries (`:25,29`) and none are
removed. It grows for the entire session and is the closest thing buffr has to a
real leak — bounded only by how long you chat and how long each answer is.

**The GC, and why it matters *more* now.** V8 runs a generational mark-and-sweep
collector: young objects die fast in a cheap minor GC; survivors get promoted.
The batch CLIs barely stress it — **they exit in seconds**, so whatever the GC
doesn't reclaim, process exit hands back to the OS wholesale. The chat process is
the opposite: it doesn't exit until `/exit`, so `turns[]` and the `pending[]`
slots are *promoted to old space* and stay there. A leak that's invisible in a
fire-and-exit CLI becomes a real (if slow) one in a session you leave open for
hours.

### Move 3 — the principle

**Whether an allocation matters depends on the process model around it.** In the
batch CLIs, lifetime is dominated by the process boundary — the unbounded
whole-file read sets the peak, exit is the final free, GC barely matters. In the
long-lived chat process the rule flips: the allocations that matter are the
*session-scoped* ones (`turns[]`, the uncleared `pending[]`), because there's no
near-term exit to reclaim them. Watch input-scaling allocations in batch; watch
session-scaling allocations in chat.

---

## Primary diagram

```
  buffr's memory map — allocations by lifetime

  ┌─ V8 heap (one process) ───────────────────────────────────────┐
  │                                                               │
  │  PER-OP (born and freed inside one iteration):                │
  │   readFile string ── scales with FILE SIZE (unbounded) ◄── watch│
  │   embedding number[768] + its [..] string literal ── ~12KB ea │
  │   SQL param objects ── tiny                                    │
  │                                                               │
  │  PER-TURN (alive until flush):                                │
  │   pending[] promises ── grows per emitted event               │
  │                                                               │
  │  PER-SESSION (chat — alive until /exit):                      │
  │   turns[] React array ── grows every turn, never trimmed ◄── watch│
  │   pending[] SLOTS ── never cleared after flush                │
  │   pg.Pool + idle clients ── until session.close()             │
  │                                                               │
  └───────────────────────────────────────────────────────────────┘
        │ batch: GC sweeps between ops, exit reclaims EVERYTHING
        │ chat:  no near-term exit → session-scoped arrays promoted to old space
        ▼
   batch peak ≈ largest file · chat growth ≈ turns × answer size
```

---

## Implementation in codebase

**Use cases.** Memory shape is reached for whenever input size grows — indexing a
large document, or an agent run that emits many trace events. Both set the heap
peak.

**The unbounded read** (`src/cli/index-cmd.ts`, lines 22–25):

```
  src/cli/index-cmd.ts  (lines 22–25)

  for (const path of paths) {
    const text = await readFile(path, 'utf8');        ← ENTIRE file → one heap string
    await indexDocumentRow(pool, cfg.appId, pipeline, { id: basename(path), text, ... });
    process.stdout.write(`indexed ${path}\n`);
  }                                                    ← `text` reassigned next iter →
       │                                                 previous file's string now
       │                                                 collectable (last ref gone)
       └─ peak heap during indexing = the single largest file, held whole. Fine
          for markdown; the allocation is unbounded in file size (see 06 for the
          streaming alternative that would cap it).
```

**The serialize-then-hold-both allocation** (`src/pg-vector-store.ts`, lines 15–17, 55):

```
  src/pg-vector-store.ts  (lines 15-17, 55)

  function toVectorLiteral(v: number[]): string {
    return `[${v.join(',')}]`;             ← 768-float array → one big string
  }
  ...
  [c.id, ..., toVectorLiteral(c.vector), ...]   ← array AND string both live here briefly
       │
       └─ momentarily holds the number[] (~6KB) and its string form (~6KB) at
          once, per chunk. Freed after the insert resolves. Bounded, small —
          this one never sets the heap peak.
```

**The per-turn array, never cleared** (`src/supabase-trace-sink.ts`, lines 50, 87–92):

```
  src/supabase-trace-sink.ts  (lines 50, 87–92)

  private readonly pending: Promise<void>[] = [];   ← built once per session (chat)
  ...
  private push(p) { this.pending.push(p); }          ← grows every turn
  async flush() { await Promise.all(this.pending); } ← awaits but does NOT clear
       │
       └─ flush() resolves the promises but never empties the array. In a batch
          run that's fine — exit frees it. In chat the same sink lives the whole
          session, so the array's slots accumulate across turns (the resolved
          promises are light, but the array itself only grows). A reset
          (this.pending.length = 0) after flush would cap it. (see 03)
```

**The session-scoped React array** (`src/cli/chat.tsx`, lines 11, 25, 29):

```
  src/cli/chat.tsx  (lines 11, 25, 29)

  const [turns, setTurns] = useState<Turn[]>([]);    ← session-lifetime state
  ...
  setTurns((t) => [...t, { role: 'you', text: q }]);     ← append, never remove
  setTurns((t) => [...t, { role: 'buffr', text: answer }]); ← append, never remove
       │
       └─ grows for the entire session; nothing trims it. The closest thing buffr
          has to a real leak — bounded only by chat length × answer size. Benign
          for a short chat, a slow climb for a session left open for hours.
```

---

## Elaborate

V8's generational GC rests on the *weak generational hypothesis*: most objects
die young. buffr fits this perfectly — file strings, embedding arrays, and SQL
params are all born and die within one loop iteration, so they're reclaimed by
cheap minor GCs and never promoted to old space. This is why a CLI that
allocates a lot but holds little stays flat in memory.

The interesting tension is *process model vs leak* — and the chat path makes it
concrete instead of hypothetical. A slowly growing array that never resets (the
uncleared `pending[]`, or `turns[]`) is a classic leak in a long-lived process.
In the batch CLIs it can't leak across runs — there's one run, then exit — so the
identical code is benign. In chat the *same* sink and the `turns[]` state live
the whole session, so they accumulate. That's the lifetime lesson made real here:
the *correctness* of an allocation pattern depends on the process model around
it, and buffr now ships both models. → `02` for the two process shapes, `06` for
streaming as the fix to the unbounded read, `03` for what fills `pending[]`.

**Not yet exercised:** heap profiling, `--max-old-space-size` tuning,
`Buffer`/`ArrayBuffer` manual memory, weak references (`WeakMap`/`WeakRef`), and
any trimming/windowing of the session-scoped arrays. None *measured* yet — but
the long-lived chat process is exactly where a heap snapshot would now earn its
place. At single-user laptop scale the growth is slow enough to ignore today.

---

## Interview defense

**Q: What's the peak memory of an index run, and what drives it?**

```
  peak heap during indexing

  ┌─ one file string (whole) ─┐  ← the dominant, input-scaling allocation
  │  + 768-float arrays/strings│
  │  + SQL params              │
  └────────────────────────────┘
   peak ≈ largest single file + small per-chunk overhead
```

It's the whole-file `readFile` (`index-cmd.ts:23`) — files load entirely into a
heap string before chunking, so peak heap tracks the largest file. Everything
else (embeddings, params) is small and per-chunk. *Anchor:* the unbounded
allocation is the read; that's where streaming would earn its place.

**Q: `pending[]` and `turns[]` only grow and never reset. Isn't that a leak?** In
the batch CLIs, no — one run, then exit, so nothing accumulates. In `chat`, yes —
that's the honest answer now. The sink and `turns[]` (`chat.tsx:11`) live the
whole session, `flush()` resolves the promises but never clears the array
(`supabase-trace-sink.ts:91`), and `turns[]` only appends. It's a *slow* leak,
fine for a normal chat, a real one for a session left open for hours. The fix is
trimming/windowing. *Anchor:* the identical code is benign in the short-lived CLI
and a leak in the long-lived session — the process model decides.

---

## Validate

1. **Reconstruct:** list buffr's dominant heap allocations and order them by
   lifetime (per-op → per-turn → per-session/process).
2. **Explain:** why is `turns[]` (`chat.tsx:11`) a slow leak in `chat` but the
   equivalent growth in a batch CLI is not? What clears `pending[]`, and what
   doesn't (`supabase-trace-sink.ts:91`)?
3. **Apply:** someone indexes a 2GB log file. Trace what happens to the heap at
   `index-cmd.ts:23` and name the fix.
4. **Defend:** the chat process is long-lived now. Argue what would force you to
   take a heap snapshot, and name the two session-scoped arrays you'd inspect.

---

## See also

- `02-processes-threads-and-tasks.md` — the two process models (batch exit vs held chat)
- `03-event-loop-and-async-io.md` — what pushes promises into `pending[]` (now 6 event types)
- `06-filesystem-streams-and-resource-lifecycle.md` — streaming vs the whole-file read
- `00-overview.md` → "Not yet exercised" — streams / heap-profiling gap

---

Updated: 2026-06-24 — flipped the "short-lived → no leak" framing: chat is long-lived, so `turns[]` (`chat.tsx:11`) and the never-cleared `pending[]` (`supabase-trace-sink.ts:91`) are session-scoped slow leaks promoted to old space; added per-turn vs per-session lifetime tier.
