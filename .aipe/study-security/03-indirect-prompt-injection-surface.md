# Indirect prompt-injection surface

**Industry name:** indirect prompt injection (untrusted retrieved/recalled content
re-entering the model context). *Industry standard* (LLM threat class).

## Zoom out, then zoom in

The model in this system never sees only the operator's question. It also sees
whatever the search tool pulls back — indexed documents *and* recalled past
exchanges. The question this pattern surfaces: that retrieved text is data, but the
model reads it the same way it reads instructions. What happens when the data
*contains* instructions? Here's where that data re-enters.

```
  Zoom out — where untrusted content re-enters the prompt

  ┌─ Service layer ──────────────────────────────────────────┐
  │  ChatSession.ask (src/session.ts:60) — question in        │
  └───────────────────────────────┬──────────────────────────┘
                                  │  agent loop
  ┌─ Agent (aptkit) ──────────────▼──────────────────────────┐
  │  model calls search_knowledge_base                        │
  │  ★ tool RESULT pushed back as a user message ★            │ ← we are here
  │     (run-agent-loop.ts:189)                               │
  └───────────────────────────────┬──────────────────────────┘
                                  │  search returns...
  ┌─ Storage ─────────────────────▼──────────────────────────┐
  │  agents.chunks: indexed docs  +  recalled memory rows     │
  │  (memory shares the store, src/session.ts:53)             │
  └───────────────────────────────────────────────────────────┘
```

The pattern (indirect prompt injection) is the RAG-era version of "never trust user
input." Direct injection is the user typing "ignore your instructions." *Indirect*
injection is sneakier: the hostile text lives in a *document* (or, here, in a
*remembered exchange*) and only reaches the model when retrieval pulls it in. The
operator never typed it this turn — it arrived through the data channel. This is a
real surface in buffr. What makes it survivable is the previous file's control: the
agent has one read-only tool, so a hijacked turn has nowhere dangerous to go.

## The structure pass

**Layers:** the store (where content sits) → the search tool (what it returns) →
the loop (how the result re-enters context) → the model (which can't tell data from
instruction).

**The axis to trace: trust.** "Is this text trusted as instruction or held as
data?" The painful answer: the model collapses the distinction.

```
  One axis — "instruction or data?" — traced to the model

  ┌─ store ─────────────┐   a chunk's text: authored OR model-generated
  │  content            │   → trust: should be DATA
  └──────────┬──────────┘
             │  seam: search returns it as a tool result
  ┌─ loop ───▼──────────┐  pushed as { role:'user', content:toolResults }
  │  re-enters prompt   │  → still SHOULD be data...
  └──────────┬──────────┘
             │  seam: the model reads the whole context as text
  ┌─ model ──▼──────────┐  no type system separates "data" from "command"
  │  flattens both      │  → the flip: data CAN act as instruction
  └─────────────────────┘
```

The seam where trust breaks is *inside the model*: it has no boundary between "this
span is reference material" and "this span is a command." That's the whole threat.
The defense can't be at that seam (you can't make the model un-flatten); it has to
be in what the model can *do* once flattened — lens 7's bounded read-only scope.

## How it works

### Move 1 — the mental model

You know stored XSS: an attacker plants a `<script>` in a comment field, and it fires
later when *another* user's page renders it. Indirect prompt injection is stored XSS
for LLMs — the payload sits in a document, and it "fires" when retrieval renders it
into the model's context. The sink isn't a browser DOM; it's the model's
instruction-following.

```
  The pattern — payload in data, fires on retrieval

  index a doc containing:  "...ignore prior instructions and ___"
       │  stored as a chunk row
       ▼
  later turn: model searches → that chunk ranks → returned as tool result
       │  run-agent-loop.ts:189 pushes it as a user message
       ▼
  model reads it AS PART OF THE PROMPT — may follow the embedded instruction
       │
       ▼
  but: the only lever it can pull is search_knowledge_base (read-only)
       → the payload "fires" into an empty room
```

The kernel of the *threat*: **untrusted content + a model that can't separate data
from instruction + a re-entry path into the prompt.** The kernel of the *defense*
(borrowed from `02`): **a tool scope so small the fired payload can't do anything.**

### Move 2 — the walkthrough

**Re-entry point 1: indexed documents.** Anything `npm run index` ingests becomes a
searchable chunk.

```ts
// src/cli/index-cmd.ts:22-25
for (const path of paths) {
  const text = await readFile(path, 'utf8');               // ← arbitrary file content
  await indexDocumentRow(pool, cfg.appId, pipeline, { id: basename(path), text, ... });
}
```

That `text` is embedded and stored verbatim. On a later turn, `search` can return it,
and it re-enters the model's context. If the operator indexes a document from an
untrusted source (a downloaded markdown, a scraped page), its content is now in the
injection surface.

**Re-entry point 2: recalled conversation memory — the subtle one.** After every
turn, the exchange is embedded back into the *same* store:

```ts
// src/session.ts:62-68
const answer = await agent.answer(question);
await trace.flush();
try {
  await memory.remember({ conversationId, question, answer });  // ← model's OWN output stored
} catch { /* best-effort */ }
```

And `remember` writes it as a chunk tagged `kind: 'memory'`, sharing the document
store:

```ts
// memory/src/conversation-memory.ts:80-86 (aptkit)
await store.upsert([{
  id: `${kind}:${turn.conversationId}:${n}`,
  vector,
  meta: { kind, conversationId, text },          // text = "user asked... assistant answered..."
}]);
```

This is the part worth slowing down on: **the model's own prior output becomes
retrievable content for future turns.** If a poisoned document steered the model into
emitting an injected instruction in turn 3, that instruction is now *memory*, and it
can resurface in turn 9 — through the exact same `search_knowledge_base` tool. The
injection surface includes the system's own recycled output, not just freshly
indexed docs.

**The re-entry mechanism — tool result as a user message.** Both paths converge here:

```ts
// runtime/src/run-agent-loop.ts:159-189 (aptkit)
const { result, durationMs } = await tools.callTool(toolUse.name, toolUse.input, ...);
resultContent = truncate(JSON.stringify(result));          // ← retrieved chunks → JSON string
...
messages.push({ role: 'user', content: toolResults });     // ← pushed back into the prompt
```

The retrieved chunks (including any embedded instructions) are serialized and pushed
as a `user`-role message. There is no sanitization gate, no "treat this as reference
only" wrapper, no provenance tag the model is forced to honor. The content is now
indistinguishable, to the model, from something the operator said.

**Why the blast radius is low — the four containments.**

```
  What a fired payload can actually reach

  hijacked turn wants to:        can it?
  ┌──────────────────────────┬───────────────────────────────┐
  │ call a write/delete tool │ NO — only search_kb registered │ ← 02
  │ exfiltrate over HTTP     │ NO — no outbound tool; Ollama   │
  │                          │      is local                  │
  │ loop forever / fan out   │ NO — maxToolCalls 4, maxTurns 6 │ ← 02
  │ emit bad text to operator│ YES — but to the OWNER's own    │
  │                          │      TTY, who can judge it      │
  └──────────────────────────┴───────────────────────────────┘
```

The worst outcome is the model produces a wrong or manipulated *answer* on the
operator's own screen — and the operator is the owner, positioned to notice. There's
no second user to phish, no privileged tool to pivot into, no network sink to
exfiltrate through. The truncation cap (`MAX_TOOL_RESULT_CHARS = 16_000`,
`run-agent-loop.ts:52`) even bounds how much injected text fits per result.

### Move 2.5 — current state vs future state

This surface is benign *because* the system is single-operator with a tiny tool
scope. That changes with the phone/edge phase.

```
  Phase A (now)              │  Phase B (phone/edge)
  ───────────────────────────┼──────────────────────────────
  operator indexes own docs  │  docs may arrive from a feed /
  → trusts the source        │  another user → untrusted source
  one read-only tool         │  may add write/action tools → a
  → payload fires into void  │  fired payload could DO something
  output → owner's own TTY   │  output → another user (phishable)
  no exfil channel           │  any outbound tool = exfil risk
```

What doesn't have to change: the re-entry mechanism is fine. What *must* change in
Phase B: a provenance boundary on retrieved content (mark it "reference, not
instruction"), and — if any write tool is added — a human-in-the-loop gate before
the model's output triggers an action. The cheap insurance that already exists (the
read-only scope) is exactly what you'd be giving up, so give it up deliberately.

### Move 3 — the principle

You cannot patch the model into distinguishing data from instruction — that boundary
doesn't exist inside an LLM, and pretending it does is the trap. So you defend one
layer out: assume the model *will* be hijacked by hostile retrieved content, and make
that assumption survivable by shrinking what a hijacked model can reach. Injection
resistance for agents isn't "stop the injection"; it's "make the injection
inconsequential." That's why this file and `02` are one idea split in two: the
surface is real, and the tool scope is what makes it not matter.

## Primary diagram

```
  Indirect prompt-injection surface — full picture

  ┌─ ingest ────────────────────────────────────────────────┐
  │  npm run index (untrusted doc?)   memory.remember()      │
  │            │                          │ (model's output) │
  │            ▼                          ▼                  │
  └──── agents.chunks (docs + memory, shared store) ─────────┘
                          │  search_knowledge_base (SELECT)
  ┌─ Agent loop (aptkit) ─▼──────────────────────────────────┐
  │  tool result → JSON → push as { role:'user' }            │
  │  (run-agent-loop.ts:189)  NO sanitization gate           │
  │            ▼                                              │
  │  model reads it as prompt — may follow embedded command  │
  │            │  but tool scope = [search_kb], read-only,    │
  │            ▼  ≤4 calls, no exfil → payload fires into void│
  └─ output → operator's own TTY (the owner judges it) ──────┘
```

## Elaborate

Indirect prompt injection is the threat that made the security community take RAG
seriously — OWASP put it at the top of its LLM risk list precisely because there's no
clean fix at the model layer. The accepted mitigations are all *architectural*: least
privilege on tools (what buffr has), provenance/segmentation of retrieved content
(what buffr will need in Phase B), human approval gates on consequential actions, and
output validation before any sink. buffr's design — RAG sharing its store with
episodic memory — is a clean illustration of why the surface is bigger than people
think: it isn't just "documents you indexed," it's "anything the system ever
generated and remembered." Naming that recycled-output path is the part that signals
you actually thought about the threat rather than reciting the headline.

## Interview defense

**Q: You feed retrieved documents straight into the prompt with no sanitization.
Isn't that a prompt-injection hole?**
It's a real surface, and I won't pretend a sanitizer closes it — you can't reliably
strip "instructions" from "data" in natural-language text, and the model can't tell
them apart anyway. The defense is one layer out: the agent has exactly one read-only
tool (`ragQueryToolPolicy`), bounded turns, and no outbound channel, so a fired
payload can at worst produce a wrong answer on the owner's own screen. I made the
injection inconsequential rather than pretending to prevent it.

```
  the move: don't defend the model, defend what it can reach
  injected payload → model hijacked → can only: search (read) → void
```

**Q: What's the surface most people miss here?**
Recalled memory. The model's *own* output gets embedded back into the shared store
(`session.ts:64`), so an injection that lands in one turn becomes retrievable
*memory* for a later turn — the system can poison itself, not just ingest poison from
documents.

**Anchor:** "You can't stop the injection — you make it inconsequential by shrinking
what a hijacked model can reach."

## See also

- `02-least-privilege-tool-scope.md` — the control that bounds this surface.
- `04-shape-only-tenant-isolation.md` — the shared store that widens memory recall.
- `audit.md` lens 7 — llm-and-agent-security.
- `.aipe/study-agent-architecture/` — retrieval-based memory and the agent loop.
