# 05 · Memory: Stack, Heap, GC, and Lifetimes

**Allocation, heap pressure, garbage collection, and object lifetimes** · *Industry standard*

---

## Zoom out, then zoom in

Where does buffr's memory go, and what holds it? Three allocations dominate, and
all three are short-lived because the process itself is short-lived: the
**whole file read into a string** (`index-cmd.ts:23`), the **embedding arrays**
(768 floats each, serialized to a text literal), and the **`pending[]` promise
array** that grows for one agent run and is dropped at flush. There's no manual
memory management — V8's garbage collector reclaims everything — but the
*shapes* of these allocations are worth seeing, because two of them scale with
input size and one of them holds references that prevent collection until a
specific await.

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
  one agent run     pending[], conversationId     GC after flush / exit
  whole process     pg.Pool, config, module vars  process exit
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
          │ pending[]    → the array field on the │  ← held the WHOLE run;
          │                sink holds every promise│     each promise keeps its
          │                until flush             │     closure data alive too
          └──────────────────────────────────────┘
```

The answer that matters: `pending[]` is the longest-lived growing allocation in
a run. Every pushed promise keeps alive whatever its closure captured (the
event content string, the pool reference) until `flush()` resolves it and the
array goes out of scope.

**Seams:**

- **stack ↔ heap.** Primitives and references sit on the stack frame; the
  strings, arrays, and objects they point to live on the heap. The `for` loop
  variable `path` is on the stack; the file contents it reads are on the heap.
- **alive ↔ collectable.** An object becomes collectable the instant its last
  reference drops. For `pending[]` that's after `flush()` completes and the sink
  is no longer reachable.

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

**The heap, allocation #3 — the `pending[]` promise array.** During an agent
run, `SupabaseTraceSink.pending` (`supabase-trace-sink.ts:24`) grows by one
promise per emitted event. Each promise retains its closure: the `pool`, the
`conversationId`, the event content string. The array — and everything it
transitively holds — stays alive until `flush()` resolves them and the sink
falls out of scope at process end. For a normal agent run that's a handful of
promises; it only matters if an agent emitted thousands of events without an
intermediate flush. The kernel:

```
  pending[] lifetime — grows, then released as a unit

  emit ─► push p1 ─► push p2 ─► push p3 ─► ... ─► flush()
            │         │         │                   │
            └─ each holds its closure data alive ───┘
                                                    │
                          after flush resolves & sink unreachable → all GC'd
```

**The GC, and why it barely matters here.** V8 runs a generational
mark-and-sweep collector: young objects (most of buffr's allocations) die fast
in a cheap minor GC; survivors get promoted. buffr never tunes it — no
`--max-old-space-size`, no manual `global.gc()`. And critically: **the process
exits in seconds.** Whatever the GC doesn't reclaim, process exit hands back to
the OS wholesale. A long-lived server must care about GC pauses and leaks; a
fire-and-exit CLI mostly doesn't, because its memory ceiling is "one run's worth"
and then it's gone.

### Move 3 — the principle

**In a short-lived process, lifetime is dominated by the process boundary, not
the GC.** The allocations that matter are the *unbounded* ones — the whole-file
read scales with input — because those set the peak heap. The GC handles the
rest invisibly, and process exit is the final, total free. Watch for allocations
that scale with input; ignore the ones that don't.

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
  │  PER-RUN (alive until flush / exit):                          │
  │   pending[] promises ── grows per emitted event               │
  │   pg.Pool + idle clients ── until pool.end()                  │
  │                                                               │
  └───────────────────────────────────────────────────────────────┘
        │ GC sweeps the dead between ops
        │ process exit reclaims EVERYTHING at the end
        ▼
   peak heap ≈ largest file + a run's worth of promises
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

**The per-run array** (`src/supabase-trace-sink.ts`, lines 24, 38):

```
  src/supabase-trace-sink.ts  (lines 24, 38)

  private readonly pending: Promise<void>[] = [];   ← grows for the whole run
  ...
  await Promise.all(this.pending);                   ← after this, array + closures
       │                                                become collectable
       └─ each promise retains its captured content string + pool ref until it
          settles. Released as a unit once flush resolves and the sink is
          unreachable. Matters only if an agent emits thousands of events.
```

---

## Elaborate

V8's generational GC rests on the *weak generational hypothesis*: most objects
die young. buffr fits this perfectly — file strings, embedding arrays, and SQL
params are all born and die within one loop iteration, so they're reclaimed by
cheap minor GCs and never promoted to old space. This is why a CLI that
allocates a lot but holds little stays flat in memory.

The interesting tension is *short-lived process vs leak*. In a server, a slowly
growing array like `pending[]` would be a classic leak — it never resets across
requests. Here it can't leak across runs because there's only one run, then exit.
The same code that would be a bug in a daemon is benign in a CLI. That's the
lifetime lesson: the *correctness* of an allocation pattern depends on the
process model it runs in. → `02` for why this process model was chosen, `06` for
streaming as the fix to the unbounded read, `03` for what fills `pending[]`.

**Not yet exercised:** heap profiling, `--max-old-space-size` tuning,
`Buffer`/`ArrayBuffer` manual memory, weak references (`WeakMap`/`WeakRef`).
None needed at single-user laptop scale.

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

**Q: `pending[]` only grows and never resets. Isn't that a leak?** In a server,
yes — that's textbook. Here, no: the process runs one agent query and exits, so
the array can't accumulate across runs, and `flush` makes its contents
collectable. The same pattern would be a real bug in a daemon. *Anchor:* whether
an allocation pattern is a leak depends on the process lifetime around it.

---

## Validate

1. **Reconstruct:** list buffr's three dominant heap allocations and order them
   by lifetime (per-op → per-run → per-process).
2. **Explain:** why is `pending[]` (`supabase-trace-sink.ts:24`) not a memory
   leak in this repo, even though it only grows?
3. **Apply:** someone indexes a 2GB log file. Trace what happens to the heap at
   `index-cmd.ts:23` and name the fix.
4. **Defend:** argue why buffr correctly ignores GC tuning, and name the single
   change (a long-lived daemon) that would force you to care.

---

## See also

- `02-processes-threads-and-tasks.md` — the process model that makes exit the final free
- `03-event-loop-and-async-io.md` — what pushes promises into `pending[]`
- `06-filesystem-streams-and-resource-lifecycle.md` — streaming vs the whole-file read
- `00-overview.md` → "Not yet exercised" — streams / heap-profiling gap
