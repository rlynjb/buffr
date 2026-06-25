# Chapter 1 — The Pitch

In the first ten minutes of every interview, someone asks you to walk through what you built. Most candidates ramble. They start with the framework, drift into a feature list, mention three things they didn't finish, and lose the room before they've said what the project *is*. This chapter is about not doing that — saying what `buffr-laptop` is in ten seconds, thirty seconds, and ninety seconds, each version a clean compression of the one above it.

The pitch is harder than it looks because compression is hard. You know everything about this project. The skill is leaving 95% of it out and keeping the load-bearing 5%. The version that wins isn't the one that lists the most; it's the one that makes the interviewer think "okay, this person knows exactly what they built and why."

```
  THREE PITCHES — same project, three altitudes

  ┌─ 10 seconds (the elevator) ───────────────────────────────┐
  │  WHAT it is. One sentence. No stack names.                │
  │  "A laptop RAG agent — ask questions about my own         │
  │   notes, answered locally, no cloud."                     │
  └───────────────────────────────┬───────────────────────────┘
                                  │  they nod, want more
  ┌─ 30 seconds (the hallway) ────▼───────────────────────────┐
  │  WHAT + the shape + the one interesting constraint.       │
  │  Adds: pgvector, local Gemma, single-device, a live       │
  │  chat REPL, consumes a toolkit as a library.             │
  └───────────────────────────────┬───────────────────────────┘
                                  │  "tell me more"
  ┌─ 90 seconds (the real answer) ▼───────────────────────────┐
  │  WHAT + the flow (index → ask) + one hard choice +       │
  │  one honest limit. This is the answer to                  │
  │  "tell me about a project."                              │
  │  Lands the diagram in their head, then hands them         │
  │  a thread to pull.                                        │
  └───────────────────────────────────────────────────────────┘
```

The pyramid is the discipline: each layer is the one above it plus one more idea, never a restart. You should be able to stop at any layer and have said something complete.

## The 90-second pitch, written out

Here's the full version. Read it aloud. It should take about ninety seconds at a normal speaking pace, and every sentence should be one you can defend.

  ┌─────────────────────────────────────────────────────────┐
  │ THEY ASK                                                 │
  │   "Tell me about a project you built."                   │
  │                                                         │
  │ WHAT THEY'RE TESTING                                     │
  │   Can you compress? Do you lead with what it IS or do   │
  │   you bury it under stack names? Do you know which       │
  │   one decision was interesting, or is every part        │
  │   equally important to you (which means you don't know   │
  │   which part carried the weight)?                        │
  └─────────────────────────────────────────────────────────┘

Your strong answer, in your voice:

> "It's buffr — a personal RAG agent that runs entirely on my laptop. I point it at my own markdown notes, it indexes them into Postgres with pgvector, and then I hold a conversation with it in the terminal. A local Gemma model answers, grounded in the chunks it retrieves — nothing leaves the machine.
>
> The shape is the classic retrieve-augment-generate loop, but with two deliberate constraints. First, it's local-first: the embeddings come from a local nomic model, generation is local Gemma through Ollama, and the vectors and my relational data live in the same single Postgres instance. Second, I consume an agent toolkit — aptkit — as a library and never edit it; my job was the persistence layer, the pgvector adapter, an interactive chat CLI built in Ink — React in the terminal — and the trajectory capture on top.
>
> The interface is a long-lived chat session: one conversation held in-process across turns, and it remembers — after each exchange I embed the question and answer back into the same store, so a later session can pull a relevant past exchange back by similarity. The piece I'm proudest of is the storage boundary. I implemented the toolkit's VectorStore contract over pgvector, so the agent loop — and the memory engine — have no idea they're talking to Postgres instead of an in-memory store; same contract, swapped body. The thing I'm still watching is evaluation: I score retrieval with precision and recall, but I don't yet measure whether the answer is faithful to the chunks. That's the next thing I'd build."

That's it. Notice what it does: it says what it is in the first sentence, names the shape, names two real constraints, volunteers one strength *and* one honest gap, and ends on a thread the interviewer can pull. You've handed them the next question on purpose.

  ┃ "End the pitch on a thread you want them to pull,
  ┃  not on a feature list that makes them change
  ┃  the subject."

### The 30-second and 10-second versions

The 30-second hallway version drops the proudest-part and the gap, keeps the shape:

> "buffr is a laptop RAG agent. I index my own notes into Postgres with pgvector, then chat with it in the terminal — a local Gemma model answers from the retrieved chunks, fully local, no cloud. I built the persistence and the Ink chat CLI on top of an agent toolkit I consume as a library."

The 10-second elevator drops everything but the what:

> "It's a RAG agent that runs on my laptop — I ask questions about my own notes and it answers locally, no cloud."

Each is a strict prefix of the bigger one. You never restart. You expand.

## Strong vs. weak — the same pitch, two ways

The failure mode here is so common it's worth seeing side by side. Same project, same person, two openings.

  ┌──────────────────────────────┬──────────────────────────────┐
  │ WEAK PITCH                   │ STRONG PITCH                 │
  ├──────────────────────────────┼──────────────────────────────┤
  │ "So I used TypeScript and    │ "It's a RAG agent that runs  │
  │ Node, with Postgres, and     │ on my laptop — I ask         │
  │ pgvector for the vectors,    │ questions about my own notes │
  │ and Ollama, and I used this  │ and a local model answers    │
  │ library called aptkit, and   │ from the retrieved chunks,   │
  │ it does RAG, and there's a   │ nothing leaves the machine."  │
  │ CLI, and I was going to add  │                              │
  │ a UI but didn't get to it…"  │                              │
  ├──────────────────────────────┼──────────────────────────────┤
  │ Why it's weak:               │ Why it works:                │
  │ Leads with stack names, not  │ Leads with what it IS, in    │
  │ purpose. The interviewer     │ plain language. The          │
  │ still doesn't know what the  │ interviewer can picture it   │
  │ app DOES. Ends on a thing    │ immediately. Stack names     │
  │ you didn't finish, which is  │ come later, attached to      │
  │ the worst possible last      │ decisions. Ends on a real    │
  │ impression.                  │ property (local-first).      │
  └──────────────────────────────┴──────────────────────────────┘

The weak pitch isn't wrong on any fact. Every word is true. It just front-loads the incidental (which language, which library) and buries the essential (what the thing is). An interviewer hears the weak version and thinks "I'm going to have to dig to find out if this person understands their own project." They hear the strong version and think "good, now I know what we're talking about — let's go deeper."

## Where the pitch goes next

Once you've pitched, the interviewer steers. The branches are predictable.

```
  You give the 90-second pitch.
        │
        ├─► IF THEY ASK "why local-first?"
        │     → Chapter 3. Short version: privacy over my
        │       own notes, no per-query cost, and it forced
        │       me to solve the local-model problems
        │       (Gemma has no native tool-calling).
        │
        ├─► IF THEY ASK "walk me through the architecture"
        │     → Chapter 2. Go to the whiteboard. Draw the
        │       index path and the query path. Don't talk
        │       before you draw.
        │
        ├─► IF THEY ASK "what's the hardest part?"
        │     → Chapter 6. The embedding-dimension one-way
        │       door, or the tool-call emulation. Pick one
        │       and go deep.
        │
        └─► IF THEY ASK "did you build the agent loop?"
              → Be exact: no, I consume it from aptkit. I
                built the persistence, the pgvector adapter,
                the Ink chat CLI, the chat session, the trace
                sink, and the memory wiring. Chapter 8 trains
                this honesty.
```

The point of mapping the branches is that you stop fearing the follow-up. Every direction the conversation can go is a chapter you've already read.

  ┃ "You're not improvising the interview. You've
  ┃  already walked every branch."

## When you don't know

Even in the pitch, an interviewer can pull a thread you haven't thought about. The recovery is the same everywhere in this book, and it's worth installing early.

  ╔═══════════════════════════════════════════════════════════╗
  ║ WHEN YOU DON'T KNOW                                       ║
  ║                                                          ║
  ║   They ask, right out of the pitch: "What's your         ║
  ║   queries-per-second?" You have no number — it's a       ║
  ║   single-user CLI, you never load-tested it.             ║
  ║                                                          ║
  ║   Say:                                                   ║
  ║   "I never measured QPS — it's a single-operator CLI,    ║
  ║    so there's exactly one caller and concurrency was     ║
  ║    never a design goal. If I were turning it into a      ║
  ║    service I'd start by load-testing the embedding hop   ║
  ║    and the Gemma generation, since those dominate the    ║
  ║    wall-clock, not Postgres. Want me to walk the         ║
  ║    bottleneck order?"                                    ║
  ║                                                          ║
  ║   What this signals: you know the question doesn't       ║
  ║   apply to what you built, you're not embarrassed by     ║
  ║   that, and you can immediately pivot to the version     ║
  ║   of the question that DOES apply. Three senior          ║
  ║   signals in one move.                                   ║
  ║                                                          ║
  ║   Do NOT say:                                            ║
  ║   "Um, I think it could handle, like, a few hundred?"    ║
  ║   A made-up number you can't defend is worse than no     ║
  ║   number. The follow-up ("how did you measure that?")    ║
  ║   ends the bluff instantly.                              ║
  ╚═══════════════════════════════════════════════════════════╝

## What you'd change

If you rebuilt the pitch itself, you'd lead even harder with the *single most interesting* property and let the interviewer pull the rest out of you, rather than front-loading the constraints. The 90-second version is good, but the strongest pitches say less and trust the follow-up to surface the depth. The thing you'd genuinely change about the *project* relevant to the pitch: you'd have a faithfulness number to cite, so the pitch could end on "and I measure answer quality at X" instead of "and measuring answer quality is the next thing." A number you can say out loud is worth more than a plan you can describe.

## One-page summary

**Core claim:** Lead with what the project *is*, in plain language, then expand by one idea at a time — never restart, never front-load stack names.

**The questions, with one-line answers:**
- *"Tell me about a project."* → buffr: a laptop RAG agent, index my notes into pgvector, chat with it in the terminal, local Gemma answers from retrieved chunks, nothing leaves the machine.
- *"Why local-first?"* → Privacy over my own notes, no per-query cost, and it forced the hard local-model problems.
- *"Did you build the agent loop?"* → No — I consume aptkit as a library. I built persistence, the pgvector adapter, the Ink chat CLI, the chat session, the trace sink, the memory wiring.
- *"What's your QPS?"* → Never measured; single-user CLI. The bottleneck is embedding + Gemma generation, not Postgres.

**Pull quotes:**
- "End the pitch on a thread you want them to pull."
- "You're not improvising the interview. You've already walked every branch."
- "Concept files for the deep dive. This book for the wide opener."

**What you'd change:** Have a faithfulness number to cite, so the pitch ends on a measurement, not a plan.

---

Updated: 2026-06-24 — the interface is now a live Ink chat REPL (`npm run chat`), not the removed one-shot `ask`; folded the chat session and the cross-session conversation memory into the 90s/30s pitches and the follow-up branches.
