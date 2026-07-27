# Chapter 2 — The Architecture

After the pitch lands, the interviewer says "walk me through the architecture." This is the
whiteboard moment. The goal is to re-draw buffr from scratch, with confidence, in ninety
seconds — labelled, layered, with the request flow traced end to end. You think in pictures
first, so this plays to your strength: you're not reciting a stack, you're drawing a diagram
you've drawn before and narrating it as you go.

The trap in this chapter is the interrupt. Interviewers don't let you finish the architecture
walk — they jump in at the database, or the agent loop, or "wait, where does the embedding
happen?" You need to know where they'll cut in and have the one-sentence answer ready, then
return to the flow.

## The architecture, full page

This is the diagram you draw. Practice drawing it until you can do the five bands and the two
flows without thinking. Everything else in the chapter hangs on it.

```
  buffr-laptop — the whiteboard architecture (single device, one user)

  ┌─ UI layer ─────────────────────────────────────────────────────────────┐
  │  the terminal frontend (`chat.tsx`) — Ink / React-in-terminal           │
  │    state: turns[], input, busy · onSubmit → session.ask()               │
  └────────────────────────────────┬────────────────────────────────────────┘
                                   │  hop 1: ask(question)  in-process call
  ┌─ Session layer (buffr owns) ───▼────────────────────────────────────────┐
  │  createChatSession (`session.ts`) — orchestrator, built ONCE             │
  │    per turn:  persist user msg → agent.answer(q) → trace.flush →         │
  │               memory.remember(exchange)                                  │
  └────────────────────────────────┬────────────────────────────────────────┘
                                   │  hop 2: agent.answer(q)
  ┌─ Agent layer (aptkit — never edited here) ─────────────────────────────┐
  │  the agent (`RagQueryAgent`) — a ReAct loop, maxTurns 6, maxToolCalls 4 │
  │    model.complete → model picks: call the tool, OR answer               │
  │    ONE tool: search_knowledge_base (read-only)                         │
  │    final turn: tools stripped → forced synthesis                       │
  └──────┬──────────────────────────────────────┬──────────────────────────┘
         │ hop 3: embed + ANN search             │ hop 4: generate
         ▼                                       ▼
  ┌─ Adapter layer (buffr owns) ──────────┐   ┌─ Provider layer (Ollama) ───┐
  │  the adapter (`PgVectorStore`)        │   │  gemma2:9b (generation)     │
  │   .search(vector, k) → cosine SELECT  │   │  nomic-embed (768d embed)   │
  │  the trace sink (`SupabaseTraceSink`) │   │  HTTP localhost:11434        │
  │   all 6 event types → messages        │   └─────────────────────────────┘
  └──────┬────────────────────────────────┘
         │ hop 5: node-postgres, direct TCP
         ▼
  ┌─ Storage layer (Postgres `reindb`, schema `agents`) ───────────────────┐
  │  documents · chunks (vector(768), HNSW cosine) · conversations          │
  │  messages (trajectory) · profiles · memory rides chunks (kind=memory)   │
  └────────────────────────────────────────────────────────────────────────┘
```

The one thing to say out loud while you draw it: "the dotted line is between aptkit and
buffr — the library and the body. The agent loop is the library's; the Postgres adapter and
the trace sink are mine." That sentence tells the interviewer you understand the seam, which
is the most senior thing on the board.

## "Walk me through a request"

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "Walk me through what happens when I type a question."        │
│                                                                 │
│ WHAT THEY'RE TESTING                                            │
│   Can you trace one request end-to-end and name every hop —     │
│   not just list components, but show data MOVING through them?  │
│   Do you know which layer owns what, and where control passes   │
│   from your code to the library to the model?                  │
└─────────────────────────────────────────────────────────────────┘
```

Trace it as a flow, one hop at a time. This is the answer, in your voice:

> "I type a question into the OpenTUI input and hit enter. `onSubmit` in `chat.tsx` calls
> `session.ask()` — that's hop one, an in-process call, no network.
>
> Inside `ask`, three things happen in a fixed order. First I persist the user turn to the
> `messages` table. Then I call `agent.answer(question)` — and now control passes into aptkit,
> the library. Then, after, I remember the exchange.
>
> The agent runs a ReAct loop. The model looks at the question and decides whether to search.
> Almost always it calls the one tool it has — `search_knowledge_base`. That tool embeds the
> question through nomic-embed into a 768-dimension vector, hands it to my `PgVectorStore`,
> which runs a cosine-distance SELECT against the HNSW index and returns the top-k chunks. Those
> chunks come back as the tool result and re-enter the model's context.
>
> The model now answers, grounded in those chunks. The loop is capped — six turns, four tool
> calls — and on the last turn the tool schemas get stripped so the model is forced to
> synthesize an answer from what it has. It can't loop forever.
>
> The whole time, every event the agent emits — each step, each tool call start and end, model
> usage, warnings, errors — flows into my trace sink and lands in the `messages` table as a
> replayable trajectory. After the answer comes back, I embed the exchange back into the same
> vector store as memory. That's the turn."

Notice the flow names the boundary crossing explicitly — "now control passes into aptkit." A
flow that crosses a layer without naming it hides the most important thing it could show.

```
┌─────────────────────────┬─────────────────────────┐
│ WEAK ANSWER             │ STRONG ANSWER           │
├─────────────────────────┼─────────────────────────┤
│ "The question goes to   │ "onSubmit calls         │
│ the agent, the agent    │ session.ask, which       │
│ searches the database,  │ persists the turn, then  │
│ and the model gives     │ hands control to the     │
│ back an answer."        │ aptkit agent loop; the   │
│                         │ model calls the one      │
│                         │ search tool, which embeds│
│                         │ and runs a cosine SELECT │
│                         │ against the HNSW index..."│
├─────────────────────────┼─────────────────────────┤
│ Why it's weak:          │ Why it works:           │
│ "goes to the agent" is  │ Names each hop, each    │
│ hand-waving. No hops,   │ owner, the embed step,  │
│ no embedding step, no   │ and the moment control  │
│ boundary between your   │ crosses from your code  │
│ code and the library.   │ into the library. It    │
│ Sounds like you read    │ sounds like you wrote   │
│ about it, not built it. │ it.                     │
└─────────────────────────┴─────────────────────────┘
```

> ▸ A flow that crosses a layer without naming the crossing
>   hides the most important thing it could show.

## Where they'll interrupt — and what to say

This is the part of the chapter that wins interviews. You will not finish the walk uninterrupted.
Have these ready.

```
"Walk me through the architecture."
      │
      ▼
You start drawing the five bands.
      │
      ├─► THEY INTERRUPT AT THE DATABASE
      │     "Why is the vector store in the same Postgres as everything
      │      else?" → "Operational simplicity. One instance, no network
      │      hop to a separate vector DB, no second billing surface. The
      │      cost I'm watching is that pgvector is slower than a dedicated
      │      engine at billions of rows — not my scale." (full defense: ch 3)
      │
      ├─► THEY INTERRUPT AT THE AGENT LOOP
      │     "How does the model know to call a tool?" → "It doesn't,
      │      natively — Gemma has no tool-calling. aptkit emulates it: it
      │      renders the tool's JSON schema into the system prompt and
      │      parses a JSON object back out of the model's prose. That's
      │      the reliability ceiling." (full defense: ch 4, ch 6)
      │
      ├─► THEY INTERRUPT AT THE MEMORY BOX
      │     "Where does memory live?" → "It rides the same chunks table,
      │      tagged kind=memory. No separate store. That's only possible
      │      because I dropped the chunks→documents foreign key — a memory
      │      row has no document behind it." (full defense: ch 3, ch 6)
      │
      └─► THEY INTERRUPT AT THE aptkit BOUNDARY
            "What's the line between buffr and aptkit?" → "aptkit is the
             agent loop, the model contract, the retrieval pipeline —
             consumed as a versioned package, never edited here. buffr
             owns the Postgres adapter, the trace sink, and the session.
             I depend on the ports, not the implementations." (full: ch 3)
```

The move every time: answer in one or two sentences, name where the full defense lives ("happy
to go deeper on that"), and *return to the flow*. Don't let an interrupt derail the whole walk —
acknowledge, compress, continue.

## When they push past your depth

The architecture is yours, so the depth-trap here is narrow: the internals of the library you
consume but didn't write.

```
╔═══════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                       ║
║                                                           ║
║   They ask: "Inside the ReAct loop in aptkit — how does  ║
║   it manage the message history between turns? How does   ║
║   forceFinal actually strip the schemas?"                 ║
║                                                           ║
║   You wrote the adapter and the session. You did NOT      ║
║   write the agent loop — it's aptkit's. You know its      ║
║   contract and its caps, not every line of its internals. ║
║                                                           ║
║   Say:                                                    ║
║   "That's inside the aptkit agent loop, which I consume   ║
║    as a library — I wrote the toolkit but I'm defending   ║
║    buffr here, the body around it. I know the contract:   ║
║    maxTurns 6, maxToolCalls 4, and on the final turn it   ║
║    strips the tool schemas so the model must synthesize.  ║
║    The exact message-history bookkeeping inside the loop  ║
║    I'd have to open the file to walk line by line. Want   ║
║    me to reason through what it MUST be doing?"           ║
║                                                           ║
║   What this signals: you know the boundary of what you    ║
║   own, you know the contract cold, and you offer to       ║
║   reason from first principles rather than bluff.         ║
║                                                           ║
║   Do NOT say:                                             ║
║   "It just keeps a list of messages and appends to it,    ║
║    I think." — a vague "I think" about your own toolkit   ║
║    reads worse than a clean boundary. Own what you own;   ║
║    name what you consume.                                 ║
╚═══════════════════════════════════════════════════════════╝
```

## What you'd change about the architecture

If you were drawing this fresh today, the one structural thing you'd reconsider is the
two-transaction write in the index path. Right now `indexDocumentRow` writes the `documents`
row on the pool directly — one autocommit transaction — and then `pipeline.index` lands the
chunks in a *second*, separate transaction inside `PgVectorStore.upsert`. A crash between them
leaves a document row with no chunks, and because you dropped the foreign key, the engine won't
complain. It's invisible. You'd either wrap both writes in one transaction, or accept the split
explicitly and add a reconciliation pass. It's not a bug at single-operator scale — you re-index
by hand — but it's an assumption you'd want to make a decision instead.

## One-page summary

**Core claim:** Re-draw buffr as five labelled bands with two flows, name the seam between
aptkit (the library) and buffr (the body), and trace one request hop by hop. The whiteboard
walk is yours to win — the only depth-trap is the library internals you consume but didn't
write.

**Questions covered:**
- *"Walk me through what happens when I type a question."* → onSubmit → session.ask (persist →
  answer → remember) → ReAct loop → search tool embeds + cosine SELECT against HNSW → grounded
  answer → trajectory flushed → exchange remembered.
- *"Why is the vector store in the same Postgres?"* → operational simplicity; one instance, no
  network hop (full defense ch 3).
- *"How does the model call a tool?"* → it doesn't natively; aptkit emulates by parsing JSON
  from prose (full defense ch 4).
- *"Where does memory live?"* → the same chunks table, kind=memory, enabled by the dropped FK.
- *"What's inside the aptkit loop?"* → name the boundary; know the contract (caps, forced
  synthesis); offer to reason rather than bluff.

**Pull quotes:**
- "Thin body, thick library. The seam is the port."
- "A flow that crosses a layer without naming the crossing hides the most important thing it
  could show."

**What you'd change:** Wrap the index path's document write and chunk write in one transaction
— today they're two, so a crash between them orphans a document with no chunks, and the dropped
FK means nothing complains.
