─────────────────────────────────────────────────
me.md — reader profile and thinking style
─────────────────────────────────────────────────

A reference document the other specs (study-system-design.md,
study-ai-engineering.md, study-prompt-engineering.md,
rehearse-interview-defense.md, and any future specs in
this family) can consult when they need to calibrate
to Rein specifically — voice, examples, format,
anchoring, and what to avoid.

This file is not a generator. It produces no
artifact of its own. It is *referenced* by other
specs as a source of truth for who the reader is,
how she thinks, what she's already built (and
therefore what makes a credible example), and what
register the writing should land in.

When a spec needs to know "what kind of example
will Rein recognize," "what voice should I write
in," or "what's the right entry point for this
concept," it consults this file rather than
inventing each time.

═════════════════════════════════════════════════
WHO YOU ARE — the spine
═════════════════════════════════════════════════

You are Rein, a Software Engineer 3, based in
Seattle. Seven-plus years of professional frontend
experience — primarily Vue and React, shipped to
customers including FedEx, Amazon, and CoreWeave.
You're credited with ~$700K in client cost savings
across that span.

You are now pivoting deliberately into AI
engineering. Not abandoning frontend — composing it
with a new layer. You're working through Interview
Kickstart's frontend program in parallel with
building AI-native projects of your own.

```
THE ARC

  past 7+ years            now              next
  ─────────────────        ─────────        ────────────────
  frontend specialist      pivot point      AI engineer
  (Vue / React)            (this is         (AI product /
  enterprise customers     where you are)   AI-native apps)
  ($700K cost savings)
       │                        │                  ▲
       │                        │                  │
       └────── carries ────────►┼─────── builds ───┘
                                │
                         frontend instincts +
                         systems thinking +
                         AI-first product sense
```

You are not starting over. The 7 years of frontend
work is the load-bearing layer — what you carry
forward, not what you replace. The pivot is
additive.

You're open to senior frontend roles, senior AI
engineering roles, or product engineering roles
that compose the two. The portfolio (reincodes,
plus the five featured projects) is the case for
that combination.

═════════════════════════════════════════════════
HOW YOU THINK — the cognitive shape
═════════════════════════════════════════════════

```
THE LEARNING LOOP — how knowledge becomes real for you

   idea arrives          you can see the shape
   as a picture          before you can articulate
        │                the mechanism
        ▼                       │
   ┌─────────────┐               │
   │ shape       │◄──────────────┘
   │ (visual)    │
   └──────┬──────┘
          │  takes time —
          │  the picture is fast,
          │  the mechanism is slow
          ▼
   ┌─────────────┐
   │ mechanism   │  you walk the layers,
   │ (logic)     │  but you don't trust
   └──────┬──────┘  the logic until...
          │
          ▼
   ┌─────────────┐
   │ hands-on    │  ...you build it.
   │ (code)      │  the visualizer
   └──────┬──────┘  swapping bars in front
          │         of you is when the sort
          │         becomes real.
          ▼
    understanding
    that transfers
```

Four observations about this loop, each with a
direct consequence for how to write *for* you:

  ## 1. You think visually first

  Ideas arrive as pictures. You see the shape of a
  solution before you can articulate its parts.
  This is direct in your code — you built
  visualizers for every algorithm because you
  cannot fully trust the algorithm until you see it
  execute in front of you. Bubble sort isn't real
  until the bars swap on screen. The grid graph
  isn't real until BFS lights up the cells.

  **Consequence for explanations:** diagrams are
  not decoration. They are the primary medium. A
  concept that lands as a diagram lands; a concept
  that lands as a paragraph has not landed yet,
  even if you can recite it. Specs writing for you
  should lead with a diagram and let prose fill in
  what the diagram can't show — not the other way
  around. This is consistent with the shared `format.md` rule:
  diagrams are primary; prose fills in what diagrams
  cannot show.

  ## 2. Ideas come fast, details take time

  You arrive at the *what* of a problem quickly and
  spend longer arriving at the *how* and *why*.
  This is not a defect — it's a thinking pattern.
  The fast arrival means you don't need to be
  walked into the concept slowly. The slow descent
  into details means you need the details *worked
  through carefully*, not glossed.

  **Consequence for explanations:** skip the
  on-ramp. Don't spend three paragraphs setting up
  what RAG is before showing how it works. You
  already see RAG as a shape (retrieve → augment →
  generate). What you need is the layered
  walkthrough of *each* part with the mechanism
  named precisely. Move 1 of How it works (mental
  model + diagram) can be tight. Move 2 (layered
  walkthrough) is where the writing has to slow
  down.

  ## 3. You value language-agnostic patterns

  You've moved from Vue to React. You translate
  Python to TypeScript routinely (Graph2.py →
  Graph2.ts, BinaryHeap.py → BinaryHeap.ts). When
  you say "I implemented a priority queue" you mean
  the concept, not the syntax — the same priority
  queue could be Python, TypeScript, Rust, or
  pseudocode and you'd recognize it.

  This is the deeper pattern: **the concept is the
  signal; the syntax is incidental.** Frameworks
  rotate (Vue → React → Next.js → whatever's next),
  but `useState`-shaped reactivity is the same
  primitive in all of them. Vector stores rotate
  (Pinecone → pgvector → Weaviate → Qdrant), but
  the pattern of *embedding + ANN + retrieval* is
  the same shape. Specs writing for you should
  reach for the pattern, name the canonical example
  once, and not anchor entire explanations to a
  single vendor or framework.

  **Consequence for explanations:** banned as the
  *primary* anchor: vendor-specific framing
  ("Pinecone does this," "Next.js does this"). The
  primary anchor is the pattern. Vendor specifics
  show up under "how this codebase handles it" or
  inside the Elaborate block, where they belong.

  ## 4. Fundamentals matter more than surface — and
  hands-on is how fundamentals become real

  Both halves of this are load-bearing. You value
  fundamentals: you implemented BinaryHeap and
  PriorityQueue from scratch even though
  npm has libraries that do this in three lines.
  You're working through IK's curriculum methodically.
  You're not chasing the surface of every new tool;
  you're going back to the substrate.

  *And* you don't trust the fundamentals until
  you've built with them. The PriorityQueue isn't
  real until Dijkstra's animation uses it to find a
  path through your grid. The Graph class isn't
  real until BFS lights up the river-crossing
  puzzle. The RAG pattern isn't real until you
  shipped AdvntrCue.

  **Consequence for explanations:** the structure
  that lands for you is *concept → mechanism →
  code in your own repo*. The concept names the
  fundamental. The mechanism walks the layers. The
  code anchors the abstract to something you can
  open and read. This is the spine of how the
  concept files in `format.md` are structured (Zoom
  out → How it works, which now carries the code from
  your codebase inline alongside the pattern teaching).
  The combination of foundation + hands-on is the
  whole point — neither alone is enough.

═════════════════════════════════════════════════
WHAT YOU'VE BUILT — DSA portfolio
═════════════════════════════════════════════════

This section is for specs that need a credible
example anchored to Rein's lived work. When a spec
needs to say "you've already built X — here's how
that maps to Y," it can pull from this.

```
DSA portfolio — what's in the reincodes repo

  ┌─────────────────────────┬──────────────────────────────┐
  │ implementation          │ where it lives in your code  │
  ├─────────────────────────┼──────────────────────────────┤
  │ Graph (adj list)        │ Graph.ts                     │
  │   BFS + DFS             │ + bfs_traversal              │
  │   Eulerian cycle/path   │ + dfs_traversal              │
  │   valid-tree check      │ + isGraphValidTree           │
  │   connected components  │ + numberOfConnectedComponents│
  ├─────────────────────────┼──────────────────────────────┤
  │ Graph2 (node+edge)      │ Graph2.ts                    │
  │   weighted edges        │ supports Dijkstra            │
  │   directed/undirected   │ + obstacle marking for grid  │
  ├─────────────────────────┼──────────────────────────────┤
  │ Binary Search Tree      │ BinarySearchTree.ts          │
  │   insert / search /     │ all three traversals         │
  │   delete (rec + iter)   │ successor / predecessor      │
  ├─────────────────────────┼──────────────────────────────┤
  │ Binary Heap             │ BinaryHeap.ts                │
  │   MinHeap + MaxHeap     │ heapifyUp / heapifyDown      │
  │   from scratch          │ insert / getMin / getMax     │
  ├─────────────────────────┼──────────────────────────────┤
  │ Priority Queue          │ PriorityQueue.ts             │
  │   heap-backed           │ enqueue / dequeue            │
  │   with updatePriority   │ value→index lookup           │
  │                         │ (used by Dijkstra animation) │
  ├─────────────────────────┼──────────────────────────────┤
  │ Tree (general n-ary)    │ Tree.ts                      │
  │   pre/post traversal    │ used in recursion call-stack │
  │   (generators)          │ visualizers                  │
  ├─────────────────────────┼──────────────────────────────┤
  │ Sorting (5)             │ utils/notes/Sorting/         │
  │   selection / bubble /  │ + interactive React          │
  │   insertion / merge /   │   visualizers for all 5      │
  │   quick / heap          │   (animated bar swaps)       │
  ├─────────────────────────┼──────────────────────────────┤
  │ State-space search      │ PG.ts                        │
  │   (river-crossing       │ BFS over state graph         │
  │   puzzle)               │ implicit graph from rules    │
  └─────────────────────────┴──────────────────────────────┘
```

Strong on: graph algorithms (BFS, DFS, shortest
path via Dijkstra), heaps and priority queues, BSTs
with all traversals, recursion with call-stack
visualization, sorting fundamentals. Comfortable
implementing from scratch — not just using library
versions.

Less depth on: tries, union-find, segment trees,
suffix arrays, dynamic programming beyond the
classic recursion-with-memoization patterns. These
haven't shown up in your projects yet, so an
explanation that anchors to "you've already built
X" can't reach for them.

The IK curriculum framing matters here. You're not
self-taught from internet tutorials. The DSA
foundation is structured, with comments
referencing IK lessons by date ("@note 3/8/25").
Specs that explain DSA can assume the IK
vocabulary is familiar (adjacency list, captured
set, fringe edge, etc.) without needing to
introduce it.

═════════════════════════════════════════════════
WHAT YOU'VE BUILT — system design portfolio
═════════════════════════════════════════════════

You have not built one system five times. You have
built five different system shapes, each with a
distinct architecture, each shipped end-to-end.
This is the system-design hands-on layer.

```
SYSTEM DESIGN — five shapes you've shipped

  ┌──────────────────┬─────────────────────────────────────┐
  │ project          │ what it exercises                   │
  ├──────────────────┼─────────────────────────────────────┤
  │ dryrun           │ local-first mobile + cloud sync     │
  │ Android, Kotlin  │ on-device AI (Gemini Nano)          │
  │                  │ + API fallback                      │
  │                  │ GitHub-as-backend (no SQL server)   │
  │                  │ spaced-repetition scheduling        │
  ├──────────────────┼─────────────────────────────────────┤
  │ buffr            │ canonical-local + opt-in mirror     │
  │ React Native,    │ SQLite primary, Supabase secondary  │
  │ Expo, ffmpeg     │ multi-source compose pipeline       │
  │                  │ (prose + clips → vlog)              │
  │                  │ AI-assisted compose, local-first    │
  ├──────────────────┼─────────────────────────────────────┤
  │ contrl           │ real-time on-device ML pipeline     │
  │ RN + MediaPipe   │ frame-rate latency budget           │
  │ + Vision Camera  │ no network in the hot path          │
  │ + Worklets-core  │ pose-landmark → rep counter         │
  │                  │ on-device, low power                │
  ├──────────────────┼─────────────────────────────────────┤
  │ aipe             │ markdown-as-source-of-truth         │
  │ meta-tooling     │ prompt templates as code            │
  │ (this system)    │ slash commands as the interface     │
  │                  │ describe → diagnose → act layering  │
  ├──────────────────┼─────────────────────────────────────┤
  │ AdvntrCue        │ classic RAG, serverless web         │
  │ Next.js +        │ vector + relational data colocated  │
  │ pgvector +       │   (one Postgres instance)           │
  │ GPT-4 +          │ serverless API + streaming response │
  │ Drizzle +        │ tool-calling + session memory       │
  │ Netlify Fns      │   (MemoRAG)                         │
  └──────────────────┴─────────────────────────────────────┘
```

The five shapes are deliberately distinct. They are
not "five Next.js apps." They span:

  → **Local-first vs cloud-first.** dryrun and
     buffr are local-first; AdvntrCue is
     cloud-first. contrl is fully local (no cloud
     in the hot path at all).

  → **Native mobile vs web.** dryrun is native
     Android. buffr and contrl are React Native.
     AdvntrCue is web. The frontend layer
     vocabulary changes; the system-design
     concerns stay similar.

  → **On-device AI vs cloud AI.** dryrun runs
     Gemini Nano on-device with API fallback.
     contrl runs MediaPipe on-device, no cloud.
     AdvntrCue runs GPT-4 in the cloud,
     streaming back. buffr runs Anthropic with
     local SQLite as the canonical store.

  → **Storage layering.** Each project has a
     different storage story — GitHub-as-store
     (dryrun), SQLite+Supabase (buffr), pgvector
     in Postgres (AdvntrCue), filesystem (aipe).
     This is the system-design substrate.

When a spec needs an architectural example anchored
to your work, the right move is to pull from one of
these five and walk it as a worked example. You've
shipped the architecture; the spec can refer to it
without inventing.

What you have not built yet: distributed systems at
horizontal scale, hot-path queue infrastructure
(Kafka, Redis Streams), multi-region replication,
or anything that involves real load balancing
under sustained traffic. These are the parts of
"system design" that come from large-company work
at scale, and they're not in your portfolio yet.
Specs explaining these patterns should be honest
about that gap — they can still teach them, but
they can't anchor to your code.

═════════════════════════════════════════════════
HOW TO WRITE FOR YOU — voice and format
═════════════════════════════════════════════════

When other specs need to produce content you will
read, these are the rules that apply *on top of*
whatever the spec's own rules already say. They
hold across every spec in the family.

  ## What works

  → **Diagram first, then prose.** Lead with the
     visual anchor. Use ASCII (box-drawing
     characters: ┌ ┐ └ ┘ ─ │ ═ ║ ◄ ► ▼). Diagram
     wrapped in one sentence of prose before and
     one after. This is non-negotiable; everything
     downstream depends on it.

  → **Pattern as the primary anchor.** Name the
     pattern. Name the canonical example once.
     Don't anchor entire explanations to a vendor
     or framework. RAG is the pattern; pgvector is
     the implementation you happen to have in
     AdvntrCue. The pattern survives if you swap
     the vector store.

  → **Concept → mechanism → code in your own repo.**
     The three-step structure that lands for you.
     Concept names the fundamental, mechanism
     walks the layers, code points at a file in
     one of your projects. The fundamental becomes
     real when you can open the file.

  → **Code references with file paths.** Real
     paths (`src/utils/data_structures/PriorityQueue.ts`,
     `migrations/0003_chunks.sql`). Not "some
     file in the codebase." The specificity is
     the load-bearing part.

  → **Direct, opinionated.** No hedging language
     ("might," "could potentially," "tends to").
     If something is a tradeoff, name it. If
     something in your code is suboptimal, say
     so, then explain why it was the right call
     at the time.

  → **Frontend primitives as the universal
     example.** When a spec needs a substrate-level
     anchor, reach for things you build with daily:
     a list rendering, a `.map()` with a `key`, a
     form input, a `fetch()` and its loading
     states, a DB table with rows and columns,
     a primary key. Universal across frontend
     engineers; assumes no specific product.

  ## What doesn't

  → **Long abstract definitions before the
     concrete.** Don't open with "X is a mechanism
     that..." Open with a picture or a scenario.
     The definition can come after.

  → **Analogy doing the load-bearing work or
     replacing the engineering explanation.**
     Locked doors, coat checks, librarians, post
     offices, kitchens, factories — banned when
     they stand in *for* the engineering walkthrough
     or arrive *before* it. The reader has built
     apps; reach for app-building knowledge first,
     and an analogy may land or clinch the move
     after the mechanism is on the table. (This
     rule is already in `teacher.md` / `format.md`;
     restating here so other specs that don't
     inherit either still get it.)

  → **Whole-product anchors when a primitive
     works.** "Linear does X," "Gmail does Y."
     Use these only when no lower-level primitive
     captures the concept. Most of the time, a
     todo list or a DB table is the better
     anchor.

  → **Marketing language.** Banned: "scalable
     solution," "robust architecture,"
     "cutting-edge," "industry-leading,"
     "leveraging best practices." These signal
     surface knowledge. The spec teaches by
     example — specs writing for you never use
     these phrases.

  → **Walking you slowly into the concept.** You
     arrive at the *what* quickly. The on-ramp
     is wasted on you. Don't spend three
     paragraphs setting up RAG before showing
     how it works. The mental model lands fast;
     the slow part is the mechanism walkthrough.

═════════════════════════════════════════════════
AUDIT-STYLE GENERATORS — the two-pass shape
═════════════════════════════════════════════════

This section applies to **audit-style generators**
specifically — the ones that read a real codebase
and produce a per-repo study guide describing what's
there. In the current family that's
`study-system-design`, `study-software-design`,
`study-security`, `study-testing`,
`study-debugging-observability`, and
`study-performance-engineering`. Curriculum-style
generators (`study-runtime-systems`, `study-networking`,
`study-database-systems`, `study-dsa-foundations`) do
not use this shape — they teach concepts that apply
broadly, not patterns specific to one repo.

The discipline below replaces any "fixed file list"
behavior an older audit-style spec might define. When
a spec contradicts this section, **this section
wins.**

  ## Why this exists

  Earlier versions of the audit-style generators
  produced a *fixed* file list — same 8 files in every
  repo, named after the audit lens ("system-map-and-
  boundaries.md", "caching-and-invalidation.md"). The
  output read as generic because it was: every repo
  got the same files with different content.

  The fix is a two-pass shape. Pass 1 is the audit:
  one file, one shape, every repo. Pass 2 is the
  discovered-pattern files: variable list, named after
  the patterns the repo actually exercises, different
  for every codebase. **The file list itself becomes a
  learning artifact** — a reader scanning the directory
  sees what's interesting about the repo before opening
  anything.

  ## The two passes

```
  AUDIT-STYLE OUTPUT — two passes, two artifacts

  Pass 1: THE AUDIT (fixed, every repo)
  ─────────────────────────────────────
  one file: audit.md
  N sections — one per topic lens
  "was every lens checked?"
  emits `not yet exercised` honestly
  same shape across repos


  Pass 2: DISCOVERED PATTERNS (variable)
  ──────────────────────────────────────
  one file per significant pattern
  named after the pattern, not the lens
  "what's interesting in this repo?"
  3-8 files for a typical repo
  different repos → different file lists
```

  ## Pass 1 — the audit (every repo gets this)

  Walk the codebase against the topic's lens
  inventory (each audit-style spec defines its own
  lenses — system-design has 8, security has its
  own, etc.). For each lens: name what the codebase
  actually does (with `file:line` grounding) or emit
  `not yet exercised` honestly. The audit lives in
  one file: `audit.md`. One `##` section per lens,
  each as long as the finding warrants — lenses
  that find nothing get one line.

  When a finding is significant enough to have a
  dedicated pattern file, the audit cross-links to
  it (e.g. `→ see 03-provider-abstraction.md for the
  deep walk`) rather than restating the pattern.

  ## Pass 2 — discovered patterns (repo-specific)

  Discover the architectural patterns the repo
  actually exercises and write one concept file per
  pattern. File names match the patterns. Each file
  uses the full `format.md` template.

  ### What earns its own pattern file

    → **Has a name.** 1-3 kebab-case words. "the
       API layer" is not a pattern; "streaming-
       ndjson" is. "the caching" is not a pattern;
       "caching-and-rate-limiting" is.

    → **Passes the load-bearing test.** Ask: *"if I
       stripped this pattern out, what specifically
       would the system lose?"* If you can name a
       real capability lost (sub-second response,
       OAuth identity propagation, fan-out
       parallelism), it's a pattern. If you can
       only say "it would be harder to maintain,"
       it isn't.

    → **Passes the recognition test.** A senior
       engineer skimming the file list should
       recognize each file name as a real
       architectural pattern. File names should
       *carry signal*: a reader who has never opened
       the repo should learn what the repo does from
       the file list alone.

  ### What does NOT earn its own file

    → Generic discussions of "the API layer" or
       "the storage layer" — those are lens findings;
       they live in the audit.

    → Audit observations with no named pattern
       behind them.

    → Patterns from a foundation topic (specific data
       structures, protocols, database engine choices)
       — those belong to the foundation generators.

  ### Calibration

  **3-8 pattern files for a typical repo.** Fewer
  than 3 means discovery was too conservative; more
  than 8 means the bar was too low. When in doubt,
  push down to the audit. A pattern file you can't
  fill the Interview defense block for with
  confidence is a signal the pattern isn't load-
  bearing — drop it back into the audit.

  ## File layout

```
  .aipe/study-<topic>/
    README.md                              ← reading order + cross-links
    00-overview.md                         ← one-page orientation
    audit.md                               ← Pass 1: the lens audit
    01-<discovered-pattern>.md             ← Pass 2: pattern files,
    02-<discovered-pattern>.md                       one per significant
    03-<discovered-pattern>.md                       pattern in this repo
    ...
```

  All files flat at the root of the topic folder.
  No nested sub-directories.

  ## Worked example — what good looks like

  For a repo that is a Next.js + OAuth + streaming
  LLM app with a multi-agent backend (the
  blooming_insights shape) under `study-system-design`:

```
  .aipe/study-system-design/
    README.md
    00-overview.md
    audit.md
    01-request-flow.md
    02-oauth-boundary.md
    03-provider-abstraction.md
    04-caching-and-rate-limiting.md
    05-streaming-ndjson.md
    06-multi-agent-orchestration.md
    07-client-stream-handoff.md
    08-schema-gated-coverage.md
```

  For a repo that is a local-first mobile app with
  no LLM features (the contrl shape) under
  `study-system-design`:

```
  .aipe/study-system-design/
    README.md
    00-overview.md
    audit.md
    01-local-first-sync.md
    02-on-device-ml-pipeline.md
    03-real-time-frame-budget.md
    04-canonical-local-with-cloud-mirror.md
```

  **Different repos, different file lists.** The
  `audit.md` exists in both and walks the same lenses
  (with `not yet exercised` honestly named for the
  lenses that don't apply to a given repo). The
  pattern files name what's actually worth learning.
  The file list itself is a teaching artifact.

  ## On UPDATE

  - Add new pattern files when the codebase grows a
    new pattern.
  - Update existing pattern files when the
    implementation changes.
  - Remove pattern files only when the pattern is
    genuinely gone from the codebase (not just
    refactored).
  - Regenerate `audit.md` against current evidence —
    all lenses re-walked, cross-links to pattern
    files refreshed.

  ## How audit-style specs reference this section

  An audit-style topic spec defines its own lens
  inventory (the topics specific to its domain) and
  references this section for the two-pass shape:

    "This generator is audit-style. See
     `me.md` → AUDIT-STYLE GENERATORS for the two-pass
     output discipline (audit.md + discovered pattern
     files). The lens inventory below is specific to
     this topic; the discovery rules and file-layout
     rules come from me.md."

  Topic specs do not restate the two-pass discipline.
  They cite this section and add only what's specific
  to their topic — their own lens inventory and
  worked examples in their domain.

═════════════════════════════════════════════════
HOW OTHER SPECS REFERENCE THIS FILE
═════════════════════════════════════════════════

This file is referenced, not regenerated. The
expected pattern: when a spec in this family
(study-system-design.md, study-ai-engineering.md,
study-prompt-engineering.md,
rehearse-interview-defense.md, or future specs)
needs to calibrate to Rein, it cites `me.md` and
treats the contents as a contract.

`me.md` is paired with `teacher.md`, which
defines the *writer* persona (the staff engineer
who teaches across the family). Together they
specify the conversation: `teacher.md` says who
is writing; `me.md` says who is reading. Each
generator spec reads both. They compose:
`teacher.md` sets the voice register;
`me.md` sets which examples land, what's already
known, and what's a gap.

Three common reference patterns:

  ## When the spec needs to know "what voice"

  Reference: the "HOW TO WRITE FOR YOU" section.
  The voice is consistent across the family —
  direct, opinionated, diagram-first, anchored to
  code. This file is the canonical source of
  those rules.

  ## When the spec needs an example anchored to
  Rein's work

  Reference: the DSA portfolio or system design
  portfolio tables. Pick one of the five system
  shapes (dryrun, buffr, contrl, aipe, AdvntrCue)
  or one of the DSA implementations. Walk it as
  a worked example. Don't invent examples when
  the portfolio already exercises the pattern.

  ## When the spec needs to know "what does she
  already know"

  Reference: the "WHAT YOU'VE BUILT" sections and
  the cognitive-style observations. The honest
  framing is: strong on frontend (7+ years), DSA
  fundamentals (IK curriculum), the five system
  shapes she's shipped. Less depth on distributed
  systems at scale, competitive-programming DSA
  beyond the IK set, and ML beyond what contrl
  exercises. Specs explaining patterns outside the
  portfolio should be honest about the gap rather
  than overclaim.

  ## When an audit-style spec needs the two-pass shape

  Reference: the "AUDIT-STYLE GENERATORS — the
  two-pass shape" section. Audit-style topic specs
  (`study-system-design`, `study-software-design`,
  `study-security`, `study-testing`,
  `study-debugging-observability`,
  `study-performance-engineering`) define their own
  lens inventory in their own spec, but the two-pass
  discipline (audit.md + discovered pattern files,
  pattern-discovery rules, file layout, worked
  examples) lives here. Topic specs cite this section
  rather than restating it.

═════════════════════════════════════════════════
WHAT THIS FILE DOES NOT DO
═════════════════════════════════════════════════

  → Does not generate any artifact. No output
    folder. No command. It is a reference
    document.

  → Does not override individual spec rules. If
    `format.md` defines the Zoom-out block or the
    How it works moves, this file does not change
    that. It adds layer-on-top calibration — voice,
    examples, anchoring — to whatever the
    consuming spec already defines.

  → **One exception: the two-pass shape for audit-
    style generators.** That discipline is defined
    in this file (AUDIT-STYLE GENERATORS section)
    and DOES override any conflicting "fixed file
    list" behavior in an older audit-style spec.
    When a topic spec contradicts the two-pass
    shape, this file wins. The shape is a
    cross-cutting rule about how audit artifacts
    are produced, and it lives here so updates
    propagate to every audit-style generator
    automatically.

  → Does not lock the reader profile. As Rein
    builds new projects or shifts focus, this
    file updates. The system-design portfolio
    will grow. The DSA portfolio will grow. The
    career arc will move. The file is meant to
    stay current.

  → Does not flatter. The strengths and the gaps
    are both named. The honest framing is what
    makes the file useful to other specs — they
    can calibrate accurately rather than
    overclaim what the reader knows.
