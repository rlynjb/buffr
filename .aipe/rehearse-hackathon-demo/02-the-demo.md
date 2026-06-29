# Chapter 2 — The Demo   (1:00–6:00, 5 minutes)

## Opening hook

This is the chapter that wins or loses the slot. Five minutes, the most
budget in the book, and one moment that earns all of it: at roughly 2:45
buffr recalls something you discussed in a *prior session* — not this
conversation, a different one — and the room goes "oh, it remembers me."
That is your money shot. Everything before it builds to it; everything after
it is you proving it wasn't a fluke.

The trap here is the tour. Do not walk every feature. You have three live
beats — grounded answer, the recall, and the proof it's local — and the
recall is the only one that matters. Spend your minutes accordingly: get to
the money shot fast, let it land, then breathe. A demo that buries the wow
at minute four has already lost the judges who decided at minute two.

## The time-budget bar

You own 1:00 to 6:00. The single hard constraint inside it: the money shot
lands by 3:20, and ideally at 2:45.

```
  ┌──────────────────────────────────────────────────────┐
  │ ░░░░░▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░ │
  │ 0:00 ─ 1:00 ──── ★2:45 ──── 6:00 ───────────── 10:00  │
  │      THE DEMO — you own 1:00 to 6:00 (5 min)          │
  │              ★ = money shot, must land by 3:20         │
  └──────────────────────────────────────────────────────┘
```

## The choreographed click-path

This is the exact sequence of screens. Three beats, in order, with the money
shot marked. The whole path runs in `npm run chat` — one terminal, one
conversation held in-process. Trace it before you read the beats.

```
  THE CLICK-PATH — buffr, one terminal, three beats

  ┌─ BEFORE YOU WALK ON (pre-flight, NOT shown) ────────────────┐
  │  npm run migrate         (schema, one-time)                 │
  │  npm run index -- corpus.md   (a reliable corpus)           │
  │  npm run chat → ask the SEED question → it answers → /exit  │
  │     ↑ this stored a PRIOR-session exchange to recall        │
  └─────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌─ BEAT 1  (1:00–2:15)  grounded answer ─────────────────────┐
  │  npm run chat  (a FRESH session — new conversation)        │
  │  you: a question that hits the indexed corpus              │
  │  buffr: grounded, cited answer                             │
  └────────────────────────────┬───────────────────────────────┘
                               ▼
  ┌─ BEAT 2  (2:15–3:20)  ★ THE MONEY SHOT ★ ──────────────────┐
  │  you: a PARAPHRASE of the seed question from the prior     │
  │       session (different words, same intent)              │
  │  buffr: recalls that PAST exchange as the top hit —       │
  │         "earlier you and I discussed…"                    │
  │  ★ THE ROOM REACTS — "it remembers me" ★                   │
  └────────────────────────────┬───────────────────────────────┘
                               ▼
  ┌─ BEAT 3  (3:20–5:30)  the local proof ─────────────────────┐
  │  show: no network call left the machine. Ollama local,    │
  │  Postgres local. your data, your model, your laptop.      │
  └─────────────────────────────────────────────────────────────┘
```

The pre-flight block is the part that makes or breaks the money shot, and
it never appears on screen. Recall retrieves from the store; if you haven't
stored a prior exchange, there is nothing to recall and Beat 2 dies. Do the
pre-flight. Then in the demo, Beat 1 establishes grounding, Beat 2 is the
recall across sessions, Beat 3 is the privacy proof.

## Beat 1 — the grounded answer (1:00–2:15)

You're carrying momentum from the cold open. Re-establish grounding fast so
the contrast in Beat 2 is sharp: this answer comes from *documents*, the
next one comes from *memory*.

```
  SHOW (on screen)                  SAY (out loud)
  ────────────────────────────      ──────────────────────────────
  fresh npm run chat, new           "Fresh conversation. I've indexed
  conversation                       my own notes into a local database."
  you ask a question that hits      "I ask something only my notes would
  the indexed corpus                 know…"
  grounded, cited answer            "…and it answers from them — cited,
  streams back                       not hallucinated. That's RAG —
                                     retrieval-augmented generation."
```

Keep this tight. Grounding is table stakes and the room knows it. Two
minutes max, then move — the money shot is the whole point.

## Beat 2 — THE MONEY SHOT, recall across sessions (2:15–3:20)

This is the moment. You ask a *paraphrase* of a question from a different,
earlier session — different words, same meaning — and buffr surfaces that
past exchange. Not a feature of this conversation. A memory of a previous
one. This is real and verified: a paraphrased query retrieved a stored
exchange as the top hit.

```
  SHOW (on screen)                  SAY (out loud)
  ────────────────────────────      ──────────────────────────────
  you type a PARAPHRASE of a        "Now — this is a brand-new
  question from a PRIOR session      conversation. I never asked this
  (different wording)                here. But buffr and I talked about
                                     this once before…"
  [hit enter — pause, let it run]   [say nothing — let the room watch]
  buffr recalls the past            "…and it remembers. That's not in my
  exchange as the top result         notes — that's a conversation we had
                                     in a different session."  ← MONEY SHOT
```

The pause after you hit enter is deliberate. Don't fill it. Let the room
read the screen and arrive at "it remembers" on their own — that's a
stronger reaction than you telling them. The line you say *after* it lands:

```
  ┃ "That's not retrieval from my documents. That's buffr remembering
  ┃  a conversation we had before — across sessions. It remembers me."
```

Say that line slowly. It's the sentence you want repeated in the hallway
afterward.

## Beat 3 — the local proof (3:20–5:30)

The secondary wow, and it costs you almost nothing because it's already
true: everything you just saw ran on your laptop. No data left the machine.

```
  SHOW (on screen)                  SAY (out loud)
  ────────────────────────────      ──────────────────────────────
  point at the running              "Everything you just saw — the model
  processes: Ollama local,           answering, the memory, the search —
  Postgres local                     ran on this laptop. Gemma via Ollama,
                                     my own Postgres."
  (optional) network monitor        "Nothing went to a cloud API. My notes,
  showing no outbound API call       my conversations, my model. My data
                                     never leaves my machine."
```

You have buffer here. If the room is engaged, this is where you can take a
breath and let the privacy story breathe. If you're tight on time, this is
the first beat to compress — see "tighten it."

## Strong vs weak — the demo move

The recall is the wow, but only if you frame it right. The weak version
buries it; the strong version isolates it.

```
  WEAK demo move                     STRONG demo move
  ──────────────────────────         ──────────────────────────────
  ask the paraphrase mid-tour,       stop, slow down, explicitly say
  let recall slide by unnamed        "this is a NEW conversation" — set
                                     up the contrast before you ask

  narrate: "now I'm querying the     stay silent after enter; let the
  memory subsystem which embeds…"    room SEE recall and react first

  explain the architecture           let "it remembers me" land, THEN
  before showing recall works        offer one line of how (ch. 3)

  show 6 features, recall = #4       three beats, recall is the peak,
                                     everything else serves it
```

## The IF-IT-BREAKS box

The money shot rides on emulated tool-calling (chapter 4): stock `gemma2:9b`
has no native tools, so the search-and-recall tool is emulated and can
occasionally not fire — buffr answers ungrounded, with no recall. This is
the single highest-risk beat in the whole demo. Build the ladder.

```
  ╔══════════════════════════════════════════════════════════════╗
  ║ IF IT BREAKS — the money shot (highest-risk beat)            ║
  ║                                                               ║
  ║ Rung 1: recall doesn't fire (answered ungrounded) → say      ║
  ║   "let me ask that more directly" and re-ask with your       ║
  ║   KNOWN-GOOD paraphrase — the exact wording you rehearsed     ║
  ║   that reliably triggers recall. Re-roll ONCE, not three.    ║
  ║                                                               ║
  ║ Rung 2: still no recall → switch to the PRE-RECORDED clip    ║
  ║   of recall working (verified earlier). Say: "here it is     ║
  ║   from a run this morning — watch it pull up our past chat." ║
  ║   The clip lands the wow even if the laptop won't.            ║
  ║                                                               ║
  ║ Rung 3: nothing loads at all → narrate the master diagram    ║
  ║   from memory (overview): "past exchanges live in the same   ║
  ║   store as my docs, so a paraphrase retrieves them." Then    ║
  ║   move to chapter 3. Never freeze, never apologize twice.    ║
  ║                                                               ║
  ║ PRE-FLIGHT (the real fix): index a corpus + store a prior    ║
  ║   exchange BEFORE you present. Empty store = dead recall.    ║
  ╚══════════════════════════════════════════════════════════════╝
```

## The "tighten it" treatment

Running long? Cut Beat 3 to a single sentence — "and all of this ran on my
laptop, nothing left the machine" — and skip the network monitor. Then trim
Beat 1 to one exchange. **Floor: the room sees recall work in Beat 2.**
Never cut below the money shot. If you have to choose between the grounded
answer and the recall, drop the grounded answer and open straight on the
recall contrast — the recall is the demo.

## The one-page run sheet — Chapter 2

```
  ┌─ THE DEMO ──────────────────── 1:00–6:00 (5 min) ────────────┐
  │  ★ MONEY SHOT lands by 3:20 (aim 2:45)                        │
  │                                                               │
  │  PRE-FLIGHT (before you walk on, not shown):                  │
  │   migrate · index a corpus · store ONE prior exchange         │
  │                                                               │
  │  BEAT 1 (1:00–2:15) grounded answer — fresh chat, cited.      │
  │   SAY: "from my own notes — cited, not hallucinated."         │
  │                                                               │
  │  BEAT 2 (2:15–3:20) ★ RECALL — paraphrase a PRIOR session.    │
  │   SAY before: "brand-new conversation. never asked this here."│
  │   [enter → SILENCE → let it land]                             │
  │   NAIL: "That's buffr remembering a conversation we had       │
  │          before — across sessions. It remembers me."          │
  │                                                               │
  │  BEAT 3 (3:20–5:30) local proof — Gemma + Postgres on laptop. │
  │   SAY: "Nothing went to a cloud. My data never leaves."       │
  │                                                               │
  │  IF IT BREAKS: re-ask known-good paraphrase ONCE → recorded   │
  │   clip → narrate the diagram. Never freeze.                   │
  │                                                               │
  │  TIGHTEN: cut Beat 3 to one line, trim Beat 1.                │
  │   FLOOR: the room sees recall work.                           │
  └───────────────────────────────────────────────────────────────┘
```

Next: chapter 3 — one level under the hood, on *why* recall works.
