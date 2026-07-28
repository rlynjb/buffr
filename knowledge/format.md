─────────────────────────────────────────────────
format.md — the concept-file format (shared reference)
─────────────────────────────────────────────────

The shape of every concept file in the study family.

  teacher.md  → who writes the file (voice, persona)
  me.md       → who reads the file (calibration)
  format.md   → how the file is structured (this file)

The topic specs (for example `study-system-design.md`,
`study-dsa-foundations.md`, `study-ai-engineering.md`,
`study-prompt-engineering.md`, and `study-agent-architecture.md`)
provide the WHAT — which
concepts, anchored to which codebase. This file
provides the structure they all fill.

Like `teacher.md` and `me.md`, this file is
**referenced, not regenerated**. It produces no
artifact of its own and names no specific project. A
spec that builds concept files reads this file for the
template, the diagram rules, the pseudocode rules, and
the hard rules — and does not restate them.

**Precedence: this file is the single source of truth
for concept structure.** Where an older embedded
template inside a topic spec differs from this file,
THIS FILE WINS.

═════════════════════════════════════════════════
HOUSE STYLE — the defining traits of every guide
═════════════════════════════════════════════════

These are the traits that make a guide *this* guide —
the identity every concept file carries. A file
missing them is off-spec regardless of how accurate
its content is. Each names the block where it lives.

Structure and teaching shape:

  1. **Zoom out, then zoom in.** Always the big shape
     before the details. The guide opens with the
     system overview (the whole system in one diagram);
     every concept file opens with the Zoom-out block
     before How it works walks the mechanics. Never a
     detail the reader can't yet place on a picture.
     → Block 2 (Zoom out); How it works Move 1.

  2. **Structure pass before mechanics.** Before walking
     any mechanism, read the system's skeleton: split it
     into layers, pick one *axis* (control / state /
     failure / trust / cost) and trace that single
     question across the layers, then find the *seams* —
     the boundaries where the axis-answer flips. Mechanics
     hang on the skeleton; never teach a moving part with
     no joint to attach it to. This is the
     simultaneous-altitude complement to trait 1: zoom
     moves wide→narrow over the file, the structure pass
     holds one question constant across every layer at
     once. → Block 3 (Structure pass).

  3. **Conversational tone.** Write like a senior
     colleague explaining it over coffee — warm,
     second-person, plain-spoken, contractions fine.
     Conversational means the *register* is a person
     talking; it does NOT mean hedging, filler, or
     slow on-ramps, which stay banned. Friendly voice,
     dense content. → teacher.md (voice register);
     strongest in Block 2.

  4. **Skeleton parts.** For any pattern with a kernel,
     isolate the irreducible core and name each part by
     *what breaks when it is missing*; separate skeleton
     from optional hardening.
     → How it works (Move 2 variant).

  5. **Step by step.** Walk the mechanism one move at a
     time — one operation per line, one moving part per
     sub-heading. The reader never holds two new things
     at once. Algorithms get an execution trace
     (variable state at every step). → How it works
     (Move 2); PSEUDOCODE RULES.

Code:

  6. **Pseudocode.** Show logic as language-agnostic
     pseudocode before (or instead of) real code —
     plain-English control flow, concrete variable
     names, one operation per line, annotated.
     → How it works (Move 2); PSEUDOCODE RULES.

  7. **Code side by side, with a line-by-line read.**
     Inside How it works, show the actual repo code
     beside an explanation of what each part does —
     annotate the specific lines, never drop a block
     raw. → How it works (Move 2).

Diagrams (ASCII, box-drawing, always):

  8. **Pattern diagrams.** Draw the *shape* of the
     pattern itself — the loop, the traversal frontier,
     the topology, the kernel. The pattern is a picture
     before it is prose. → DIAGRAM RULES; How it works
     Move 1.

  9. **Flow diagrams.** Draw sequences as box-and-arrow
     flows — request flows, auth chains, data pipelines
     — top to bottom, every arrow labelled.
     → DIAGRAM RULES.

 10. **Layer + layers-and-hops diagrams.** Draw the
     bigger picture as labelled layers (UI / Service /
     Storage / Provider bands); draw anything that
     crosses layers or services as layers-and-hops,
     with every hop between bands labelled. A diagram
     that crosses a boundary without naming it is
     off-spec. → Block 2; How it works Move 2;
     DIAGRAM RULES.

 11. **Use cases.** Every concept shows where it is
     actually reached for in this codebase — concrete
     scenarios, not abstract definitions.
     → How it works (Move 2 opening).

This list is the guide's identity and is meant to
grow. Adding a trait is a one-line addition here plus
its enforcing rule below.

═════════════════════════════════════════════════
THE CONCEPT FILE — blocks in order
═════════════════════════════════════════════════

Each concept file walks one pattern from orientation
to verified understanding, in this order:

  1.  Subtitle                    industry name(s) + type label
  2.  Zoom out, then zoom in      orient   (replaces Why care)
  3.  Structure pass              orient   layers · axes · seams
  4.  How it works                understand   pattern + your code
  5.  Primary diagram             recap visual
  6.  Elaborate                   deeper context
  7.  Project exercises           (AI / ML sections only)
  8.  Interview defense           pressure-test it
  9.  See also                    related files

```
  orient ───────────────►   understand                       defend
  ┌──────────┐ ┌─────────┐  ┌───────────────────────┐      ┌──────────┐
  │ zoom out │→│structure│→ │ how it works          │  →   │ interview│
  │ → zoom in│ │ pass    │  │ pattern + your code   │      │ defense  │
  └──────────┘ └─────────┘  └───────────────────────┘      └──────────┘
   layers dia   layers ·     skeleton + pattern/pseudo      Q + diagram
   conversational axes ·     + step by step + code          per answer
                  seams      side by side annotated
```

**Changes from the older template:**
  → Why care is REPLACED by "Zoom out, then zoom in."
  → Tradeoffs is REMOVED.
  → Tech reference is REMOVED.
  → Summary is REMOVED.
  → Implementation in codebase is REMOVED as its own
    block — code side-by-side + annotation now lives
    inside How it works (Move 2).
  → The remaining blocks are carried forward unchanged.

═════════════════════════════════════════════════
BLOCK 1 — SUBTITLE
═════════════════════════════════════════════════

Industry name(s) for the pattern plus a one-word type
label (Industry standard / Language-agnostic /
Project-specific), so another dev catches on in a
one-second lookup. The body then leads with these
industry terms and keeps the repo's local names in
parens (see the standard-term-leads rule under GLOBAL
RULES) — the subtitle names the transferable word once;
the body uses it throughout.

═════════════════════════════════════════════════
BLOCK 2 — ZOOM OUT, THEN ZOOM IN   (replaces Why care)
═════════════════════════════════════════════════

The opening block. Before any mechanism, put the
reader on the map. Two beats, in order:

  **Zoom out — the bigger picture.** Where does this
  pattern sit in the whole system? Show it as a LAYERS
  ascii diagram: the system as labelled bands (UI /
  Service / Storage / Provider), with this concept's
  box marked in the band where it lives. The reader
  sees the forest before the tree.

  **Zoom in — narrow to the concept.** Now that the
  reader knows where it sits, drop into what it is and
  the question it answers. Name the pattern. Hand off
  to How it works.

**Tone: this is the most conversational block in the
file.** Write it like a senior colleague pulling up a
diagram and saying "okay — here's the whole thing. See
this box? That's what we're talking about." Second
person, plain-spoken, inviting. Conversational is the
register, not a license to hedge or pad.

**Required diagram:** one LAYERS ascii diagram of the
bigger picture, this concept's box marked (5–14 lines).

```
  Zoom out — where this concept lives

  ┌─ UI layer ──────────────────────────────────┐
  │  React component   →   fetch()               │
  └─────────────────────────┬────────────────────┘
                            │  HTTP
  ┌─ Service layer ─────────▼────────────────────┐
  │  handler   →   ★ THIS CONCEPT ★   →   ...     │ ← we are here
  └─────────────────────────┬────────────────────┘
                            │
  ┌─ Storage layer ─────────▼────────────────────┐
  │  database / cache                            │
  └──────────────────────────────────────────────┘
```

**Banned (inherited from teacher.md):** definition-first
openings ("X is a mechanism that…"), marketing language,
and slow on-ramps. The zoom-out is fast — one diagram and
a few sentences, not three paragraphs of throat-clearing.
An analogy may anchor the concept here when it lands the
shape faster (see teacher.md), but the layers diagram
still leads the block and the mechanism is still built in
How it works.

═════════════════════════════════════════════════
BLOCK 3 — THE STRUCTURE PASS   (orient → understand bridge)
═════════════════════════════════════════════════

Zoom-out put the concept on the map. The structure pass reads the
*skeleton* of that map — what it's made of and where its joints are —
before How it works walks the mechanics. Skip it and the next block teaches
moving parts with nothing to attach them to.

The four foundations below run in dependency order (axes → seams → layered
decomposition), with the structure pass as the meta-move that sequences
them. This is still orient — keep it tight; the depth belongs in How it
works.

### Axes (dimensions of analysis)

**What it is:** A single dimension you can question every part of a system
against. Each axis is one "x-ray" of the same machine — you understand the
system once you've traced a few.

**The recurring high-leverage axes:**
- control     — who decides what happens next?
- state       — who owns it, where does it live, is it mutable?
- dependency  — who depends on whom, and which way does the arrow point?
- failure     — where does it originate, propagate, get contained?
- lifecycle   — when does this happen: build / deploy / request / idle?
- cost        — latency, money, compute per unit of work?
- guarantees  — promised vs best-effort? sync vs async? exactly-once?
- trust       — what can each side see or tamper with?

The same three boxes light up differently depending on which axis you shine
through them:

```
  One system, three axes — three different x-rays

  the system:   [ A ] ──► [ B ] ──► [ C ]

  control  →     A decides    B decides     C just runs
  state    →     A owns       B borrows     C stateless
  failure  →     A retries    B propagates  C swallows

  same boxes; each axis exposes a different truth
```

**The skill:** Picking the right axis is most of the work. The wrong axis
makes every layer look the same; the right one makes the boundaries pop.
Trace ONE axis at a time across the whole system — don't mix.

**When to use:** First move on any unfamiliar system. Before "how does it
work," ask "which dimension should I measure it along?"

**Failure mode it fixes:** Vague "it's complicated" understanding — no
chosen dimension means no contrast, so nothing stands out.

### Seams (boundaries / joints)

**What it is:** A boundary where two parts meet and where you could
intercept, substitute, observe, or test behavior without rewriting either
side. Seams are where contracts live.

**Two orientations:**
- horizontal seam — between stacked abstraction layers
                    ("what does the lower layer promise the upper one?")
- vertical seam   — between sibling modules / slices / services at the
                    same level ("what does module A promise module B?")

**The test that makes a seam worth studying:**
  → a seam matters when an AXIS flips across it.
If control, state-ownership, trust, or failure-containment changes from one
side to the other, that boundary is load-bearing. If nothing flips, the
"boundary" is cosmetic.

Made concrete — trace one axis across a boundary and watch the answer
change:

```
  A seam is load-bearing when an axis flips across it

  axis traced = "who decides control flow?"

  ┌─ outer layer ─┐    seam     ┌─ inner layer ─┐
  │  CODE decides │ ═════╪═════► │  LLM decides  │
  └───────────────┘  (it flips) └───────────────┘
         ▲                              ▲
         └──── same axis, two answers ──┘
               → this boundary carries a contract:
                 study it before either side's internals
```

**Why map seams before mechanics:**
- contracts live here  — the promises that let you reason about each side alone
- failures live here   — most bugs happen at boundaries, not inside layers
- substitution lives here — every mock / swap / cache / auth check is a seam
- complexity hides here — a clean-looking layer can hide a messy joint

**When to use:** After naming layers, before learning internals. Locate the
joints first; the mechanics hang off them.

**Failure mode it fixes:** Studying a part in isolation and being blindsided
by how it connects — the joints are where the surprises are.

### Layered decomposition (consistent lens across layers)

**Move:** Explain a system by splitting it into nested abstraction levels
(outer/inner, top/bottom, high/low), then trace ONE invariant question
across all levels — don't re-describe each layer with new vocabulary.

**The discipline:** Pick a single dimension and hold it constant while you
move up and down the stack. Candidate dimensions:
- who's in control? (caller vs callee, declarative vs imperative)
- who owns state / where does it live?
- where does failure localize, and how does it propagate?
- what's the cost / performance contract?
- what's guaranteed vs best-effort?

The insight comes from the *contrast at each altitude*, not from the layer
list itself. Hold one question still and let the answer change as you
descend:

```
  One question, held constant down the layers

  "who decides control flow?"  — trace it downward

  ┌───────────────────────────────┐
  │ outer: pipeline (fixed order) │   → CODE decides
  └───────────────────────────────┘
      ┌─────────────────────────────┐
      │ inner: ReAct loop (per step)│   → LLM decides
      └─────────────────────────────┘
          ┌─────────────────────────┐
          │ innermost: tool call    │   → TOOL runs
          └─────────────────────────┘

  the answer flips at each altitude — that contrast IS the lesson
```

One sentence that answers the same question at two levels ("outer enforces
order, inner chooses freely") teaches more than two separate paragraphs
describing each layer in its own terms.

**Bonus payoff — self-similarity:** when the same mechanism reappears at
two levels, name it once and point at both occurrences. Collapsing two
concepts into a single operation seen at different nesting depths is the
strongest version of this move ("X is just a Y with a Z inside").

**When to use:** any system with ≥2 abstraction levels where the levels
tend to get confused with each other — framework vs application code,
protocol vs transport, interface vs implementation, policy vs mechanism,
schema vs data.

**Failure mode it fixes:** describing layers in isolation, so the reader
ends up seeing the parts but not how they nest, constrain, or relate to
each other.

### Structure pass before mechanics (the meta-move)

**Move:** Before learning HOW a system works, do a structural read of WHAT
it's made of and WHERE its joints are. Three steps, in order — each read
feeds the next:

```
  The structure pass — read shape before mechanics

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  split into nested levels (outer / inner)      │
  └────────────────────────┬───────────────────────┘
                           │  then pick one dimension
  ┌─ 2. AXES ─────────────▼────────────────────────┐
  │  hold ONE question constant, up & down the stack│
  └────────────────────────┬───────────────────────┘
                           │  then find where it flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  boundaries where the axis-answer changes       │
  └────────────────────────┬───────────────────────┘
                           │  skeleton mapped → hand to
                           ▼
                   Block 4 — How it works
```

Only then dive into mechanics. The internals are far easier to absorb once
you know which layer they sit in, which axis they serve, and which seam they
sit behind. Skipping straight to mechanics = memorizing details with no
skeleton to hang them on.

**Family map (how the foundations relate):**
- zoom out/in          — altitude over time (wide context → narrow detail)
- layered decomposition — one axis held constant across altitudes at once
- axes                 — which questions are worth holding constant
- seams                — the boundaries where the axis-answers change

Hand off to How it works with the skeleton named.

═════════════════════════════════════════════════
BLOCK 4 — HOW IT WORKS
═════════════════════════════════════════════════

The load-bearing block. Zoom-out put the reader on the
map; How it works is where they actually come to
understand the thing. By the end of it the concept
should *click* — not "I read the definition" but "I
could rebuild this from memory." Length scales with
complexity: short for a debounce, long (15–20
paragraphs with sub-headings and interspersed visuals)
for multi-layer auth or a prompt-routing loop.

**Tone: stay conversational — the same register as the
Zoom-out block.** Write like a senior colleague at the
whiteboard walking you through it: second person,
plain-spoken, "okay, watch what happens when the queue
empties," "here's the part everyone trips on." The
register is a person talking; the content stays dense
and precise. No lecturing, no definition-dumps, no slow
on-ramps.

**Describe the mechanics with these six tools — and
lean on them, not prose paragraphs:**

  → **skeleton parts** — isolate the kernel, name each
    part by what breaks without it (Move 2 variant)
  → **pattern ascii diagrams** — the shape of the
    mechanism itself: the loop, the traversal, the
    topology, the kernel
  → **pseudocode** — plain-English control flow for the
    logic, concrete variable names, one operation per
    line, annotated
  → **step by step** — one moving part at a time, in
    order; the reader never holds two new things at once
  → **layers-and-hops ascii diagrams** — for anything
    that crosses layers or services, the bands plus
    every hop between them labelled
  → **code from this codebase** — real repo code shown
    side-by-side with inline annotation; name the exact
    file path, function name, and line range; the
    canonical place the pattern lives in your repo

**How it works carries BOTH the pattern AND the code
from your repo.** Teach the mechanism with the
pseudocode/diagram tools — and within Move 2, anchor
each load-bearing part to the matching code in this
codebase: real file paths, real function names, real
line ranges, shown side-by-side with inline annotation
(see the "code from this codebase" tool above). The
goal is one block that walks the reader from "what
the pattern is" to "where in your repo it lives" —
without a second block to re-stitch the connection.

By now the structure pass (Block 3) has mapped the
skeleton — the layers, the axis, the seams. How it works
walks the mechanics that hang on it. It runs in three moves.

  #### Move 1 — the mental model (the pattern's shape)

  Start with the shape, not a definition. Anchor to
  something the reader already holds — a primitive they
  build with ("you know how a `fetch()` has loading /
  success / error states? same idea here") or, when it
  lands the shape faster, an analogy ("an interface is a
  wall socket: anything with the right plug fits") — then,
  in one plain-English sentence, name the underlying
  strategy, and let the walkthrough below build the real
  mechanism. Keep it warm and direct; you're pointing at a
  picture, not reciting a glossary.

  **Required: one PATTERN ascii diagram** — the literal
  shape of the pattern (the loop, the traversal
  frontier, the topology, the kernel). This is the
  picture the reader paraphrases six weeks later. 5–12
  lines, right after the opening paragraph.

  #### Move 2 — the step-by-step walkthrough (the body)

  Walk the mechanism one moving part at a time. **Step
  by step: one operation per line, one moving part per
  bolded sub-heading — the reader never holds more than
  one new part in their head at once.** For each part,
  talk it through like you're at the whiteboard: name
  the real term, bridge from what the reader already
  knows, say what concretely happens, then name the
  boundary condition ("and here's where it breaks if
  you're not careful").

  **Every Move 2 sub-section gets at least one diagram.**
  Pick the type that matches what it describes:
    → a PATTERN diagram for the shape of the mechanism
    → a LAYERS-AND-HOPS diagram for anything that
      crosses layers or services — draw the bands and
      label every hop between them (what travels, in
      which direction)
    → an EXECUTION TRACE for an algorithm — variable
      state at each step (the values, not code lines)

  Use **PSEUDOCODE** for language-agnostic logic —
  plain-English control flow, concrete variable names,
  one operation per line, annotated. Reach for the
  actual repo code (side-by-side, annotated, with file
  + function + line range) when the specific syntax
  matters, when the load-bearing part is named, or when
  the reader needs an anchor to open and read.

```
  Layers-and-hops — label every hop between bands

  ┌─ Client ─────┐  hop 1: GET /data        ┌─ Edge ──────┐
  │  browser     │ ───────────────────────► │  CDN / LB   │
  └──────────────┘  hop 4: 200 + body ◄───── └──────┬──────┘
                                               hop 2 │ miss
                                                     ▼
                                            ┌─ Service ────┐
                                            │  handler     │
                                            └──────┬───────┘
                                              hop 3│ query
                                                   ▼
                                            ┌─ Storage ────┐
                                            │  database    │
                                            └──────────────┘
```

  #### Move 2 variant — the load-bearing skeleton

  When the concept has an irreducible *kernel* — a
  loop, a traversal, a protocol exchange, a single
  data-structure operation — run Move 2 as a
  load-bearing-skeleton walkthrough instead of a flat
  list of parts. Three steps:

  1. **Isolate the kernel.** Show the smallest
     pseudocode or shape that is still the pattern —
     nothing removed it can survive losing. The thing
     the reader should reconstruct from memory.

       BFS:          frontier queue + visited set +
                     dequeue → expand → enqueue +
                     termination (frontier empty)
       Rate limiter: counter + window + allow/deny
                     decision + window reset

  2. **Name each part by what BREAKS when it is
     missing — not by definition.** "Drop BFS's visited
     set and it revisits nodes and never terminates on a
     cyclic graph." What-breaks-if-removed is how the
     reader learns which parts are load-bearing and
     which are incidental.

  3. **Separate skeleton from optional hardening.** The
     kernel is the minimum that makes it the pattern;
     retry/backoff, observability, path compression,
     caching are hardening layered on top. Saying which
     is which is itself the lesson.

  The interview payoff: naming a load-bearing part
  people routinely forget — BFS's empty-frontier
  termination, a rate limiter's reset, an agent loop's
  hard iteration budget — signals you built the thing,
  not just read about it.

  This variant is a tool, not a mandatory move. Skip it
  for concepts that genuinely are co-equal independent
  parts with no central kernel.

  #### Move 2.5 — current state vs future state (when applicable)

  When the concept is built-but-not-active, planned, or
  in-migration, add a Phase A / Phase B sub-section with
  a side-by-side comparison diagram: what's true now,
  what's planned and why it's gated, what the migration
  costs. The takeaway is often *what doesn't have to
  change.* Skip when the concept is fully shipped.

  #### Move 3 — the principle

  End with the takeaway that generalises beyond this
  codebase — the underlying principle the concept
  exemplifies, not a summary of what was just said.

═════════════════════════════════════════════════
BLOCK 5 — PRIMARY DIAGRAM
═════════════════════════════════════════════════

The full recap visual after the mechanics — one frame
showing everything Move 2 walked through, with every
box, every arrow, and every architectural layer
labelled. The visual the reader returns to.

═════════════════════════════════════════════════
BLOCK 6 — ELABORATE
═════════════════════════════════════════════════

Deeper context: where this pattern comes from, what
problem it was invented to solve, how it connects to
adjacent concepts, what to read next.

═════════════════════════════════════════════════
BLOCK 7 — PROJECT EXERCISES   (AI / ML sections only)
═════════════════════════════════════════════════

Curriculum Build items mapped to this file's concept
IDs. One `###` subsection per exercise; six labelled
bullets: Exercise ID / What to build / Why it earns its
place / Files to touch / Done when / Estimated effort.
Generated only for sections with a curriculum
dependency; omitted elsewhere.

═════════════════════════════════════════════════
BLOCK 8 — INTERVIEW DEFENSE
═════════════════════════════════════════════════

Questions, model answers with a diagram per answer (the
visual you sketch while you speak), and a one-line
anchor per answer. Surface the load-bearing skeleton
part here when the concept has a kernel — naming the
part people forget is the strongest signal.

═════════════════════════════════════════════════
BLOCK 9 — SEE ALSO
═════════════════════════════════════════════════

Links to related files in this guide.

═════════════════════════════════════════════════
DIAGRAM RULES — apply to every diagram
═════════════════════════════════════════════════

Use box-drawing characters, never ASCII approximations:
─ │ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼ → ← ↑ ↓ ◀ ▶ ▲ ▼

Every diagram must:
  → have a title line above it
  → sit inside a fenced code block
  → label every box and every arrow that carries info
  → label every architectural layer it spans (UI /
    Service / Storage / Network boundary / Provider).
    A diagram that crosses a boundary without naming it
    hides the most important thing it could show.
  → show direction of data flow explicitly
  → be readable without the surrounding prose
  → be wrapped in prose: one sentence before, one after.
  → no Mermaid, no images.

Types of diagram, by situation:

  Pattern           the shape of a pattern or algorithm —
                    the loop, the traversal frontier, the
                    topology, the kernel skeleton (How it
                    works Move 1)
  Flow              sequences — request flows, auth chains,
                    data pipelines, top to bottom
  Layer             architecture — each layer as a band,
                    the bigger-picture orientation (Block 2)
  Layers-and-hops   crossing layers/services — the bands
                    plus every hop between them labelled
                    (what travels, which direction)
  Execution trace   algorithms — variable state at every
                    step, not just before/after
  Comparison        before vs after, with vs without,
                    Phase A vs Phase B, side by side
  Sequence          actors exchanging messages over time
  Entity            data models — tables, fields, relations
  Tree              hierarchies — component/nesting trees
  State             transitions — UI states, job statuses
  Inline annotation pointing at parts of a code snippet,
                    naming what each piece does (How it works Move 2)

═════════════════════════════════════════════════
PSEUDOCODE RULES
═════════════════════════════════════════════════

Use pseudocode when showing algorithm logic without
language noise, explaining a pattern before real code,
or when the concept is language-agnostic.

Style:
  → plain English for control flow: "for each", "if",
    "return"
  → concrete variable names, not x and y
  → one operation per line
  → annotate any non-obvious line with // comments
  → show input and output explicitly

Real code is the last tool reached for — used only when
the actual syntax matters (a specific hook, an
async/await error path). When real code appears, it is
always annotated (in How it works Move 2), never dropped
raw.

═════════════════════════════════════════════════
HARD RULES
═════════════════════════════════════════════════

  → Zoom out before zoom in. No concept file opens on a
    detail. Block 2's layers diagram comes first.
  → Structure pass before mechanics. Block 3 comes
    between Zoom out and How it works — name the layers,
    trace ONE axis (control / state / failure / trust /
    cost / …) across them, then locate the seams where
    that axis flips. How it works (Block 4) must not open
    on a mechanism until that skeleton is named.
  → No definition-first openings. Start with the
    shape/scenario, end with the term.
  → Diagrams at every move. Block 2 gets a layers
    diagram; How it works Move 1 gets a pattern diagram;
    every Move 2 sub-section gets at least one mechanism
    diagram. A prose-only mechanism walkthrough is
    incomplete.
  → How it works carries both the pattern AND the code
    references. Teach the mechanism with skeleton parts,
    pattern diagrams, pseudocode, step-by-step, and
    layers-and-hops diagrams; anchor each load-bearing
    part to real repo code (file paths + function names
    + line ranges) shown side-by-side with annotation
    inside Move 2. Pseudocode without showing the actual
    repo code at the load-bearing parts is incomplete.
  → Bridge from what the reader knows in every Move 2
    sub-section. No bridge = the work isn't done.
  → Every abstract claim is followed by a concrete
    consequence. "This is secure" is banned; "if the
    client sends X, the database returns Y" is required.
  → Name the real terms; don't dance around them.
  → Standard term leads, local name in parens. Use the
    established industry term as the noun in prose, with
    the codebase's local name in parentheses on first
    use — "the port (`DataSource`)", "the client (the
    agents)", "the adapter (`BloomreachDataSource`)",
    "the seam (the `Transport` boundary)" — never the
    reverse (`DataSource`, the port). After first
    mention the local name alone is fine. This carries
    the Subtitle's industry-name rule into the body: the
    reader learns the transferable word, then binds it to
    this repo. Prefer the settled vocabulary where it
    fits — port / interface / contract (the abstraction),
    adapter (an implementation of it), client (code that
    depends on the port), seam (a swap boundary), factory
    (selects an adapter), dependency injection (passing
    the adapter in), dependency inversion (depending on
    the port, not the adapter). Each topic supplies its
    own standard terms the same way (e.g. networking: the
    connection pool (`pgPool`)); where a concept has no
    settled industry term, the repo term stands alone.
  → Length scales with complexity, not a paragraph cap.
  → Code is shown side by side with a line-by-line read
    (inside How it works Move 2), never dropped raw.
  → Conversational register throughout; no hedging,
    marketing language, apologetic tradeoff naming, or
    slow on-ramps (see teacher.md).
  → An analogy (physical-world or software) may anchor
    or clinch a concept, but never replace it: after any
    analogy the primitive is still built in full, in
    engineering terms, so the reader can rebuild it
    without the metaphor. Prefer a software primitive the
    reader has coded when it works as well — it transfers.
    See teacher.md's analogy trait.
  → No project names except the codebase being studied;
    every file path and use case is about that repo only.
