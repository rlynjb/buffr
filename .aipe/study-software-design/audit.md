# audit.md — the 8-lens APOSD audit of buffr-laptop

Pass 1. Walk the codebase against Ousterhout's design primitives, one
lens per `##` section, each grounded in `file:line`. Where a lens finds
nothing real, it says `not yet exercised` rather than manufacturing a
finding. Where a finding earns a deep walk, it cross-links to the Pass 2
pattern file instead of restating it.

A note on size before we start: this is a small, young, single-device
codebase — eight source files, none over 95 lines. Most APOSD red flags
bite hardest in big multi-team codebases. So expect a lot of honest
"too small to show meaningful X yet" — and expect the praise findings
to outnumber the problem findings. That's not flattery; the deep-module
discipline here is genuinely good for the size.

```
  the 8 lenses, ranked by what they found in THIS repo

  FIRES / WORTH READING            QUIET / TOO SMALL YET
  ───────────────────────          ─────────────────────
  3. info-hiding (the dead         4. layers (1 clean
     cfg.schema knob — the            pass-through, fine)
     one real leak)                6. errors (handled well,
  5. pull-complexity-down             little to bite)
     (dimension owned, good)       7. readability (clean;
  2. deep-vs-shallow (mostly          two micro-nits)
     deep — praise)                8. red-flags (mostly
  1. complexity overview              doesn't-fire)
```

---

## 1. complexity-in-this-codebase

The zoom-out. APOSD names three symptoms of complexity: **change
amplification** (one decision forces edits in many files), **cognitive
load** (the module nobody wants to touch), and **unknown-unknowns** (you
can't tell what you'd have to change). Let's locate each in real files.

**Change amplification — the one real instance: the hardcoded schema.**
`config.ts:13` computes `schema: env.AGENT_DB_SCHEMA || 'agents'`. But no
file ever reads `cfg.schema`. Instead, the literal `agents.` is hardwired
into every SQL string: `pg-vector-store.ts:48` (`agents.chunks`),
`pg-vector-store.ts:72`, `runtime.ts:12` (`agents.documents`),
`profile.ts:5` (`agents.profiles`), `supabase-trace-sink.ts:6` and `:29`
(`agents.conversations` / `agents.messages`). Rename the schema and you
edit six call sites across five files — and the config knob that *looks*
like it controls this is dead. That's textbook change amplification,
made worse by a knob that lies. Full treatment in lens 3.

**Cognitive load — lowest in `pg-vector-store.ts`, and that's the
point.** The module with the most going on (a transaction, dimension
guards, vector encoding, a cosine flip, a meta round-trip) is also the
one you can use without understanding any of it: you call `upsert` and
`search`, two methods. Behind a small interface, the load stays inside
the module. That's the opposite of the symptom — it's the cure. → see
`01-adapter-behind-a-contract.md`.

**Unknown-unknowns — the undocumented meta contract.** `search` at
`pg-vector-store.ts:80-84` rebuilds `meta` with three magic keys:
`docId`, `chunkIndex`, `text`. `upsert` at `pg-vector-store.ts:44-46`
reads those same three keys back out. Nothing on the `Chunk`/`Hit` types
(`pg-vector-store.ts:4-5`) tells you these keys are load-bearing — that
the `search_knowledge_base` tool's citations break if `text` goes
missing. A new contributor indexing a document has no way to know which
meta keys matter. That's an unknown-unknown: the information needed to
change the code safely isn't visible from the code. → lens 3 and lens 7.

**The two hotspots, ranked:**
1. `config.ts` ↔ the five SQL files — the dead-`schema` leak (lens 3).
2. `pg-vector-store.ts:44-46,80-84` — the implicit meta contract.

Everything else in the repo is genuinely low-complexity for its size.

---

## 2. deep-vs-shallow-modules

Depth = functionality ÷ interface width. Deep is good (lots of behaviour,
tiny surface); shallow is the red flag (interface nearly as wide as the
body — **classitis**, a class that adds a layer without hiding anything).

**The deepest module — `PgVectorStore` (`pg-vector-store.ts:19-86`).**
Interface: two methods plus a readonly `dimension`. Body hides: a
connect/begin/commit/rollback/release transaction (`:40-64`), a dimension
guard that throws on mismatch (`:32-36`), JS-`number[]`→pgvector-text
encoding (`:14-17`), the cosine-distance→similarity-score flip
(`:69`, `1 - (embedding <=> ...)`), and the meta round-trip (`:80-84`).
A caller — `session.ts:41` — names none of that. **This is the best
deep module in the repo.** → `01-adapter-behind-a-contract.md`.

**Runner-up — `createChatSession` (`session.ts:34-76`).** Wider job
(it wires the embedder, store, pipeline, tool, model, profile, memory,
conversation, trace, and agent) behind a 2-method interface:
`ask(question)` and `close()` (`session.ts:29-32`). Eleven constructed
things, two exposed verbs. Deep. → `05-deep-session-facade.md`.

**The shallowest modules — and why it's fine here.** `db.ts` is one
function wrapping one constructor (`createPool` → `new pg.Pool`,
`db.ts:4-6`). `profile.ts` is one function wrapping one query
(`profile.ts:4-8`). By the strict ratio these are shallow — the
interface is about as big as the body. But this isn't classitis: there's
no *class* adding ceremony, and each names one decision worth isolating
(`db.ts` owns "how we get a pool"; `profile.ts` owns "most-recent
profile, empty string if none" — note the `?? ''` default at `:7`, a
real decision the caller doesn't repeat). A one-line module that hides
one decision and gives it a name is a seam, not a smell. **No fix
needed.** The honest read: the repo is too small to have grown a real
classitis offender. Watch for it if `profile.ts` ever sprouts a
`ProfileManager` class with getters that just forward.

**Verdict:** the design instinct here is right — behaviour pushed down,
interfaces kept narrow. The worst you can say is two modules are thin,
and both earn their thinness.

---

## 3. information-hiding-and-leakage

The lens that actually fires. A leak is a fact known in two modules that
forces them to change together. Find the seams where knowledge crosses
that shouldn't.

**THE leak — the dead `cfg.schema` knob (worst offender in the repo).**
`config.ts:13` produces a `schema` field. It's a promise: "the schema is
configurable." Every SQL-writing module breaks that promise by hardcoding
`agents.`:

```
  config.ts:13         schema = env.AGENT_DB_SCHEMA || 'agents'   ← COMPUTED
       │
       │  (never flows anywhere)
       ▼
  pg-vector-store.ts:48   insert into agents.chunks ...           ┐
  pg-vector-store.ts:72   from agents.chunks ...                  │
  runtime.ts:12           insert into agents.documents ...        │ HARDCODED
  profile.ts:5            from agents.profiles ...                │ 'agents.'
  supabase-trace-sink.ts:6  ... agents.conversations ...          │ ×6
  supabase-trace-sink.ts:29 ... agents.messages ...               ┘
```

The same knowledge — "the schema name" — lives in seven places (the
config field plus six literals), and they don't agree on who's
authoritative. The red flag is **the same knowledge edited in two
places**, here amplified to six. Worse, the config field is a *lie*:
setting `AGENT_DB_SCHEMA=foo` changes nothing, which is more dangerous
than no knob at all because it invites a wrong mental model.

**The move — pick one of two, don't straddle:**
- *Delete the lie.* Drop `schema` from `Config` (`config.ts:3,13`) and
  the `AGENT_DB_SCHEMA` env read. The literal `agents.` becomes the
  honest single source of truth. Cheapest, and correct for a
  single-tenant single-device app. **Recommended.**
- *Honor the knob.* Thread `cfg.schema` into every query — pass it to
  `PgVectorStore`, `loadProfile`, the trace sink, `indexDocumentRow`.
  More code, only worth it if multi-schema is a real near-term need. It
  isn't (context.md: "Schema is `agents` in database `reindb`").

Pick delete. A knob nobody turns is complexity with no payoff.

**The second leak — the implicit meta contract (`docId`/`chunkIndex`/
`text`).** This crosses a different seam: between `PgVectorStore` and
aptkit's pipeline/tool. `upsert` (`pg-vector-store.ts:44-46`) digs three
keys out of `c.meta`; `search` (`pg-vector-store.ts:83`) puts three keys
back into `meta`. The shape of that object is a contract with aptkit's
`search_knowledge_base` tool, but it's invisible — not on a type, not in
a comment naming all three keys as required. Two modules (this store and
aptkit's tool) must agree on those key names or citations silently break.
This is a real leak, but it's **partly inherited** — the key names are
aptkit's in-memory-store shape, and matching them is the whole point of
drop-in parity (context.md). Fix: a typed `ChunkMeta = { docId: string;
chunkIndex: number; text: string }` and a one-line comment at `:79`
naming the contract. → covered deeper in `01-adapter-behind-a-contract.md`.

**Not a leak (worth noting):** the soft `document_id` link with no FK
(`sql/001_agents_schema.sql`, `chunks` table) looks like a leak but is a
deliberate, documented decision — the FK is dropped so memory chunks can
exist with no `documents` row (`session.ts:52`). Information is *hidden*
correctly here; the comment at the SQL and at `session.ts:51-52` carries
exactly the knowledge a comment should.

---

## 4. layers-and-abstractions

Find pass-through methods (a method that just forwards to another with no
new abstraction) and pass-through variables (a value threaded through
layers that don't use it). Adjacent layers offering the same abstraction
earn no keep.

**One pass-through, and it's benign — `runtime.ts:17`.**
`indexDocumentRow` does real work first (it writes the `agents.documents`
source-of-truth row, `:11-16`) and *then* forwards to
`pipeline.index({ id, text })` (`:17`). That last line is a pass-through
to aptkit's pipeline — but the function isn't *just* the pass-through; it
adds the documents-row write that the pipeline doesn't know about. The
two layers offer *different* abstractions (one owns the corpus row, one
owns chunk indexing), so the layer earns its place. No fix.

**Pass-through variable — `appId`, and it's load-bearing, not noise.**
`appId` threads from `loadConfig` → `createChatSession` → `PgVectorStore`,
`loadProfile`, `startConversation`. It looks like a variable forwarded
through layers untouched. But each layer *uses* it: the store scopes
queries `where app_id = $2` (`pg-vector-store.ts:73`), profile scopes its
lookup (`profile.ts:5`), the conversation tags its row
(`supabase-trace-sink.ts:6`). A pass-through variable is only a smell
when intermediate layers carry it without using it. Here every layer
that touches it reads it. No fix.

**Verdict:** `not a problem in this repo`. The layering is shallow (CLI →
session → store → pg) and each layer changes the abstraction — UI events
become session calls, session calls become SQL, SQL becomes rows. Nothing
forwards blindly. Too few layers to grow a redundant one yet; watch for
it if a "service" layer ever appears between `session.ts` and the stores.

---

## 5. pull-complexity-downward

The red flag: a knob or parameter pushed up to the caller that the module
had enough information to decide itself. APOSD's rule — it's better for a
module to absorb complexity than to export it.

**The best example in the repo — dimension is pulled down, then taught
upward correctly.** `PgVectorStore` takes an optional `dimension` and
defaults it (`pg-vector-store.ts:29`, `?? 768`); it then *enforces* it
itself in `assertDim` (`:32-36`) on every upsert and search, throwing on
mismatch rather than making the caller check. The caller doesn't validate
dimensions — the module owns that. And the one place dimension *must*
agree (embedder vs store), `session.ts:41` wires
`dimension: embedder.dimension` so the store learns it from the embedder
instead of a hand-typed constant. The complexity (768-everywhere,
mismatch-must-throw — context.md's hard constraint) lives down in the
module where it belongs. **This is the lens working as intended.**

**The counter-example — `cfg.schema`, the knob that should never have
been exported.** Same lens, opposite verdict. The schema is a decision
the modules could own (it's a constant, `agents`), but it was pushed up
into config as a knob — and then ignored. The fix is the lens's own
prescription: pull it down. Hardcode `agents.` (already done in practice)
and delete the upward-facing knob. See lens 3.

**A small one — `embeddingModel` and `appId` on `PgVectorStoreOptions`
(`pg-vector-store.ts:7-12`).** Both are optional with sensible defaults
(`'laptop'`, `'nomic-embed-text:v1.5'`, `:27-28`). Exposing them is fine
— they're genuine per-deployment facts, and defaulting them means the
common caller passes neither. This is the *right* way to expose a knob:
optional, defaulted, the module owns the common case. Contrast with
`schema`, which is exposed but never variable. No fix.

---

## 6. errors-and-special-cases

Find exception handling scattered across call sites, and special cases a
better definition would erase. APOSD's preference: define errors *out of
existence*, mask them at a low level, or aggregate handling — not
sprinkle try/catch everywhere.

**Errors are handled at the right altitude — little to fix.**
- *Defined out of existence:* `loadProfile` returns `''` for "no profile"
  (`profile.ts:7`, `?? ''`) instead of throwing or returning null — the
  caller never special-cases "missing profile." `SupabaseTraceSink.emit`
  uses a `switch` with no `default` (`supabase-trace-sink.ts:56-84`): an
  unknown event type is silently a no-op, not an error path. Both erase a
  special case by definition.
- *Masked low:* the transaction's rollback-on-error is inside `upsert`
  (`pg-vector-store.ts:59-64`) — the caller sees a thrown error, never
  the rollback machinery.
- *Aggregated:* the chat UI has exactly one try/catch
  (`cli/chat.tsx:27-34`), turning any `ask()` failure into a rendered
  `error: <message>` turn. One catch, not one per failure mode.

**One deliberate swallow, correctly placed.** `session.ts:64-69` wraps
`memory.remember` in a try/catch with an empty body and a comment:
"a memory-write failure must not lose the answer the user has." This is a
*good* swallow — best-effort episodic memory should never fail a turn
that already succeeded. The comment carries the *why*, which is exactly
what a swallow needs to not look like a bug. No fix.

**The one gap worth naming:** the dimension guard throws a bare
`Error` (`pg-vector-store.ts:34`), as do the missing-`DATABASE_URL`
checks (`session.ts:37`). For a single-device CLI that's fine — nobody's
catching by type. If buffr ever grows programmatic callers that need to
distinguish "dimension mismatch" from "DB down," a typed error class
would let them. Not now. `mostly not yet exercised.`

---

## 7. readability — names · comments · consistency · obviousness

Four facets, one lens. This repo is clean; the findings are micro-nits,
ranked.

**Names — strong, two near-misses.** Names are precise throughout:
`assertDim`, `toVectorLiteral`, `persistMessage`, `indexDocumentRow` all
say exactly what they do. No `data`/`obj`/`tmp`/`manager` anywhere — the
classic vague-name red flag doesn't fire. Near-misses: `c` for a chunk in
the `upsert` loop (`pg-vector-store.ts:43-56`) and `r` for a row in the
`search` map (`:80`) — fine in a 3-line scope, but `chunk`/`row` would
cost nothing. Minor.

**Comments — the strength of this codebase.** The comments carry
*why*, not *what*. Examples worth copying: the cosine-distance note
(`pg-vector-store.ts:69`, "`<=>` is cosine DISTANCE; similarity = 1 -
distance") explains a sign flip you'd otherwise misread; the jsonb
stringify note (`supabase-trace-sink.ts:23-24`) explains a node-postgres
gotcha that isn't visible in the code; the `SupabaseTraceSink` class
comment (`:39-48`) explains the sync/async split and what was previously
dropped. None restate the code. **This is the model — interface comments
that say what the signature can't.**

**The one missing interface comment:** the `meta` round-trip
(`pg-vector-store.ts:79`) has a comment about *why* it rebuilds the shape,
but nothing names `docId`/`chunkIndex`/`text` as the *required* keys — the
contract a caller must satisfy. That's the comment most worth adding (see
lens 3).

**Consistency — one split convention.** Schema access is inconsistent in
*intent*: `config.ts` says schema is configurable, every query says it's
the literal `agents`. Two conventions for one job — the consistency red
flag, same root cause as lens 3. Otherwise consistent: every SQL string
uses `$n` params, every async DB call is awaited, every module imports
`pg` the same way.

**Obviousness — one "huh?" spot.** `chunkIndex` defaults to `0` when
absent (`pg-vector-store.ts:45`) but `content` defaults to `''` (`:46`).
A chunk with no `text` meta silently indexes empty content — and since
`text` round-trips into citations (lens 3), a missing key means a silent
empty citation, not a loud failure. The default hides a data problem.
Worth a thrown error or at least a warning. Minor but real.

**Verdict:** readability is a strength. The comments especially — they're
better than most production code. Fix the one missing key-contract
comment and you've closed the only real gap.

---

## 8. red-flags-audit — the capstone checklist

Ousterhout's red flags as a review checklist, each marked against this
repo: **FIRES** / doesn't / N/A, with location and the one-line fix when
it fires. Sorted by severity for buffr.

```
  RED FLAG                        VERDICT   WHERE / FIX
  ──────────────────────────────  ────────  ─────────────────────────────
  Information leakage              FIRES     cfg.schema vs 6 hardcoded
   (same knowledge, two places)   ★ worst   'agents.' literals
                                             → delete the dead knob (lens 3)

  Avoidable config / exposed       FIRES     cfg.schema knob never read
   knob the module could own       (same)    → pull the decision down

  Hard-to-describe (implicit       FIRES     meta keys docId/chunkIndex/
   contract, no type/comment)      minor     text not typed or named
                                             → add ChunkMeta type + comment

  Nonobvious code                  FIRES     content '' / chunkIndex 0
                                   minor     defaults hide missing-key bug
                                             → throw or warn on missing text

  Shallow module / classitis       doesn't   db.ts/profile.ts are thin but
                                             hide one decision each, no
                                             class ceremony — seams, not smells

  Pass-through method/variable     doesn't   runtime.ts adds the docs-row
                                             write; appId is used at every
                                             layer it threads through

  Temporal decomposition           doesn't   modules split by concern
                                             (store/profile/trace), not by
                                             execution order

  Comment restates code            doesn't   comments carry WHY, not WHAT —
                                             a repo strength (lens 7)

  Try/catch everywhere             doesn't   one catch in the UI, one
                                             deliberate swallow with a
                                             reason — errors aggregated low

  Vague names (data/obj/tmp/mgr)   doesn't   names are precise; only c/r in
                                             3-line scopes

  Repetition (same code N times)   N/A       too small; no duplicated logic
                                             block beyond the schema literal

  God class / over-large module    N/A       largest file is 94 lines
```

**The actionable index, ranked across the whole repo:**

1. **Delete the dead `cfg.schema` knob.** One leak, six call sites, a
   lying config field. `config.ts:3,13`. The single highest-leverage fix.
2. **Type the meta contract.** `ChunkMeta` + a comment naming
   `docId`/`chunkIndex`/`text` as required. `pg-vector-store.ts:4,79`.
   Closes the unknown-unknown.
3. **Throw (or warn) on missing `text` meta.** Turn a silent empty
   citation into a loud failure. `pg-vector-store.ts:46`.

Everything else is praise or "too small to bite yet." For an
eight-file repo, that's a healthy audit — the design instincts (deep
modules, why-comments, errors handled low) are right; the one structural
problem is a knob that should never have shipped.
