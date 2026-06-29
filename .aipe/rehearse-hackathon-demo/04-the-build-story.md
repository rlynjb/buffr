# Chapter 4 — The Build Story   (8:00–8:45, 45 seconds)

## Opening hook

Forty-five seconds to prove this is real software, not a mockup with a happy
path. You do it by naming the one hard part you cracked — the genuine
obstacle that almost killed the demo, and what you did about it. Judges have
seen a hundred demos that work *only* on the rehearsed click. The fastest
way to read as real is to name the rough edge yourself, with the confidence
of someone who shipped it under a clock.

Your hard part is honest and specific: stock `gemma2:9b` has no native
tool-calling, so the search-and-recall tool is *emulated*. That's the same
thing that makes Beat 2 risky — and owning it here, before a judge digs for
it, turns a weakness into a credibility signal. You're not hiding it; you
shipped around it.

## The time-budget bar

You own 8:00 to 8:45. One obstacle, one sentence on the fix. That's the
whole chapter.

```
  ┌──────────────────────────────────────────────────────┐
  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓░░░░░░░░░░░░ │
  │ 0:00 ──────────── 8:00 ─ 8:45 ──────────────── 10:00  │
  │      THE BUILD STORY — you own 8:00 to 8:45 (45 sec)  │
  └──────────────────────────────────────────────────────┘
```

## What actually shipped — the proof diagram

This is real, working code, not slideware. Four commands, each doing a real
thing against a real Postgres. Show this so "is it real?" answers itself.

```
  What shipped — four real commands, one local stack

  npm run migrate   ─►  transactional SQL migration runner
                        creates agents schema, chunks(vector 768),
                        conversations/messages, profiles
        │
  npm run index ──  ─►  embeds a corpus into pgvector
   -- <file.md>          (real documents rows + chunk rows)
        │
  npm run chat      ─►  the Ink terminal UI — the demo surface
                        long-lived session, RagQueryAgent,
                        retrieval + recall + trajectory capture
        │
  npm run eval      ─►  precision@k over a labeled query set
                        (real retrieval-quality numbers)

  consumed as a library: @rlynjb/aptkit-core — the agent loop,
  retrieval pipeline, tools, and @aptkit/memory engine.
  buffr adds the persistence (PgVectorStore) + the chat CLI.
```

The detail that sells "real" to a technical judge: the conversation-memory
engine was extracted *up* from buffr into the aptkit toolkit and re-consumed
as a published dependency. That's not hackathon glue — that's a real library
boundary you designed.

## The hard part — own it, don't hide it

Say this plainly. The structure is: here was the wall, here's why it's hard,
here's what I did.

```
  ┃ "The hard part: the model runs locally — Gemma via Ollama — and
  ┃  stock Gemma has no native tool-calling. So I had to EMULATE the
  ┃  tool interface to get it to call the search tool at all."
```

Then the honest edge, named before a judge finds it:

```
  ┃ "It's not perfect — sometimes it answers without searching. So I
  ┃  built around it: a reliable corpus indexed up front, and the
  ┃  retrieval-as-memory design so recall rides the tool it already
  ┃  has. That's the engineering — making an on-device model behave
  ┃  like an agent."
```

That second line is the whole point of this chapter. You're not apologizing
for the emulation — you're presenting it as the problem you solved. The
recovery design (chapter 2's ladder) and the same-store memory design
(chapter 3) *are* the answer to the hard part. They connect.

## Anchor it to your track record — if it fits

You've shipped on-device AI before, and it makes the emulation story read as
a pattern you know, not a one-off. One optional line:

```
  ┃ "I've shipped on-device AI before — Gemini Nano on Android, a
  ┃  MediaPipe pose pipeline at frame-rate. buffr is the same
  ┃  instinct: keep the compute local, work around what the
  ┃  on-device model can't do natively."
```

Only say this if you have the seconds. The hard part itself is the
load-bearing content; the track-record anchor is a bonus.

## Strong vs weak — the build-story move

The instinct under time pressure is to hide the rough edge. Resist it. The
named edge is what makes you credible.

```
  WEAK build story                   STRONG build story
  ──────────────────────────         ──────────────────────────────
  "everything works great, it's      "the hard part: on-device Gemma
  all running smoothly"              has no native tools — I emulated
                                     them and built around the gaps"

  hide the emulated tool-calling     name it first, before a judge
  and hope no one asks               digs it out of you

  list every feature you built       ONE obstacle, ONE fix — the
                                     thing that almost broke the demo

  "we used a lot of cool tech"       "I extracted the memory engine
                                     into a library and re-consumed it"
```

## The IF-IT-BREAKS box

No live action here, so the only failure is overrunning into your close — or
getting defensive about the emulation if a judge reacts.

```
  ╔══════════════════════════════════════════════════════════════╗
  ║ IF IT BREAKS (verbal, not technical)                         ║
  ║ A judge jumps in with "so it's not really tool-calling?" →   ║
  ║ don't get defensive. Say: "right — stock Gemma can't, so I    ║
  ║ emulated the interface. The design works around the gaps."    ║
  ║ Then move to the close. Candor reads better than a defense.  ║
  ║ Do NOT spend your 45 seconds litigating it — punt depth to   ║
  ║ Q&A and protect the close.                                    ║
  ╚══════════════════════════════════════════════════════════════╝
```

## The "tighten it" treatment

Running long? Drop the proof diagram and the track-record anchor; say only
the two hard-part script lines (emulated tools + how you built around it).
**Floor: the room hears the one hard part and that you solved it under a
clock.** That single honest sentence does more for "this is real" than the
whole feature list. If you're truly out of time, fold this into one
sentence on your way into the close: "the hard part was making a local model
act like an agent — I emulated tool-calling and designed the memory to ride
the tool it already had."

## The one-page run sheet — Chapter 4

```
  ┌─ THE BUILD STORY ────────── 8:00–8:45 (45 sec) ──────────────┐
  │                                                               │
  │  SHOW (optional): four real commands — migrate / index /      │
  │   chat / eval — against real Postgres. Real, not slideware.   │
  │                                                               │
  │  THE HARD PART (say plainly):                                 │
  │   "Gemma runs local and has no native tool-calling — I        │
  │    emulated the tool interface to make it call search."       │
  │   "It's not perfect; sometimes it skips search. So I built    │
  │    around it — reliable corpus up front, memory rides the     │
  │    same tool. That's the engineering."                        │
  │                                                               │
  │  OPTIONAL: "I've shipped on-device AI before — same instinct."│
  │                                                               │
  │  IF A JUDGE PUSHES: "right, I emulated it" — no defense, move.│
  │  TIGHTEN: two hard-part lines only.                           │
  │   FLOOR: the room hears the hard part + that you solved it.   │
  └───────────────────────────────────────────────────────────────┘
```

Next: chapter 5 — the close, the ask, the last line.
