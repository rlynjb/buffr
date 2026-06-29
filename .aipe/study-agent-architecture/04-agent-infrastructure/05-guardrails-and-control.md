# Guardrails and control — the envelope around the autonomous loop

**Industry name(s):** guardrails · the control envelope · agent safety
controls · iteration/budget caps. **Type label:** Industry standard.

**In this codebase: yes — buffr has a real control envelope.** Iteration
caps (`maxTurns`/`maxToolCalls`), a forced-synthesis budget exit, a
context-window guard that halts on overflow, a single read-only tool
(smallest blast radius), and the model-emits-intent boundary. What it
*lacks*: input sanitization and a human-in-the-loop gate — acceptable
for a single-user, read-only, local tool.

## Zoom out, then zoom in

```
  Zoom out — the control points around buffr's loop

  ┌───────────────────────────────────────────────┐
  │  Input guardrail   (validate / sanitize)      │ ← buffr: NONE (single-user)
  └────────────────────┬──────────────────────────┘
                       ▼
  ┌───────────────────────────────────────────────┐
  │  Agent loop                                   │ ← we are here
  │   • iteration cap (maxTurns:6)                │ ← buffr: YES
  │   • tool-call budget (maxToolCalls:4)         │ ← buffr: YES
  │   • context-window guard (8192, halt)         │ ← buffr: YES
  │   • human-in-the-loop pause                   │ ← buffr: NONE
  └────────────────────┬──────────────────────────┘
                       ▼
  ┌───────────────────────────────────────────────┐
  │  Output guardrail  (schema; no direct side-    │ ← buffr: read-only tool,
  │  effects — go through your code)               │   so side effects = none
  └───────────────────────────────────────────────┘
```

Zoom in: an agent without caps loops silently and burns tokens; an agent
whose output triggers side effects directly is a prompt-injection
liability. The control envelope bounds both. buffr has strong loop-level
controls and a naturally-safe output (read-only), with input and
human-gate controls absent by design.

## Structure pass

**Layers.** Three control points: input, loop, output. buffr's controls
cluster at the loop.

**Axis — "what bounds the autonomy?"** Caps bound the loop; the context
guard bounds the input size; the read-only tool bounds the output's
power. Tracing "what could run away" against "what stops it" is the
audit.

**Seam.** The model→harness boundary (again). Because the model emits
intent and the harness runs it, and the one tool is read-only, there's
no path from model output to a side effect. That seam is buffr's
strongest guardrail — and it's structural, not bolted on.

## How it works

#### Move 1 — the mental model

You bound a `while` loop with a max-iterations guard and validate
external input before trusting it. The control envelope is those
instincts applied to an agent: cap the loop, guard the window, and never
let the model's output trigger an action directly.

```
  Pattern — the control envelope (buffr's, marked)

  input → [no sanitize: single-user] →
    ┌─ loop ──────────────────────────────────┐
    │ maxTurns 6 · maxToolCalls 4              │  ← caps
    │ ContextWindowGuardedProvider (halt 8192) │  ← window guard
    │ [no human gate]                          │
    └──────────────────┬───────────────────────┘
                       ▼
    output → read-only tool → NO side effects possible
```

#### Move 2 — the walkthrough

**Loop caps: the budget exit, audited.** buffr's `RagQueryAgent` sets
`maxTurns: 6` and `maxToolCalls: 4` (`rag-query-agent.js:47-48`), and
`runAgentLoop` enforces them with the forced-synthesis turn
(`run-agent-loop.js:25-34`). This is the single most important
guardrail: without it a weak Gemma could loop tool calls indefinitely.
It's covered as a loop mechanic in
`01-reasoning-patterns/02-agent-loop-skeleton.md`; here it's named as
what it also is — the primary control on autonomy.

**Context-window guard: halt on overflow.** `ContextWindowGuardedProvider`
estimates input tokens before each call and throws
`ContextWindowExceededError` if they exceed 8192 minus an output reserve
(`context-window-guard.js:27-38`, `src/session.ts:46`). That's a control
point: it halts the run loudly rather than letting Gemma silently
truncate context into a garbage answer. It also emits a warning event to
the trace, so the halt is observable.

**Output guardrail: structurally safe, because the tool is read-only.**
buffr's strongest output control isn't a check — it's the architecture.
The model emits intent; the harness runs it (`tool-registry.js:14-24`);
and the one tool granted is `search_knowledge_base`, read-only
(`ragQueryToolPolicy`, `rag-query-agent.js:8-11`). So there is *no path*
from model output to a side effect. A prompt injection in a document or
a past exchange could at worst influence what's *said*, not *done* —
there's nothing to do. That's the smallest possible blast radius, and
it's why buffr can skip a heavy output guardrail.

**What's missing, and why it's acceptable.** No input sanitization: buffr
is single-user and local, so there's no untrusted user to defend
against (the injection surface is the *documents and memory* it
retrieves — see security). No human-in-the-loop gate: there are no gated
actions to approve, because the agent can't act. Both absences are
correct for a read-only, single-user, local tool. They'd become required
the moment buffr's two-brain design added a *writing* or *acting* tool
on the phone — that's when the output guardrail and the human gate stop
being optional.

```
  Comparison — buffr's envelope vs an acting agent's

  buffr (read-only, single-user):   acting agent (would need):
    loop caps ✓                       loop caps ✓
    window guard ✓                    + input sanitize
    read-only tool → safe output ✓    + output schema validation
    no human gate (nothing to gate)   + human gate on irreversible actions
```

#### Move 3 — the principle

The control envelope bounds an autonomous loop at three points: input,
loop, output. The cheapest and strongest output control is
architectural — keep the agent read-only so its output *can't* trigger a
side effect. buffr does exactly that, pairs it with loop caps and a
window guard, and skips the input/human controls that a read-only
single-user tool doesn't need. The discipline is matching the controls
to the blast radius, not bolting on every guardrail regardless.

## Primary diagram

```
  buffr's control envelope (what's present, what's deliberately absent)

  INPUT:  (no sanitize — single-user, local)
            │
  LOOP:   maxTurns 6 · maxToolCalls 4 · forced synthesis  ← caps
          ContextWindowGuardedProvider (halt + warn at 8192)
          (no human gate — nothing to gate)
            │
  OUTPUT: search_knowledge_base is READ-ONLY
          → model emits intent, harness runs it
          → NO path to a side effect  ← structural guardrail
```

## Elaborate

The control envelope is the agent-architecture framing of per-call
defenses: prompt-injection and error-recovery mechanics (per call) would
live in a future `study-ai-engineering` guide; this file covers them as
the *envelope* around an autonomous loop. buffr's read-only-tool stance
is the cleanest version of "never let agent output trigger side effects
directly" — it's not a check you can forget, it's a capability the agent
doesn't have. The human-in-the-loop gate is made *resumable* by graph
orchestration (`03-multi-agent-orchestration/07-graph-orchestration.md`),
which is why buffr would adopt a graph when it first needs to gate an
action.

## Interview defense

**Q: What stops buffr's agent from running away or doing harm?**
Three things. Loop caps — `maxTurns: 6`, `maxToolCalls: 4`, and a forced
synthesis turn — bound the autonomy so a weak model can't loop forever.
A context-window guard halts and warns on overflow instead of silently
truncating. And the strongest control is structural: the one tool is
read-only, so the model emits intent the harness runs, with no path from
output to a side effect. Smallest possible blast radius.

```
  caps (loop) + window guard (input size) + read-only tool (output) = bounded
```

**Anchor:** "The cheapest output guardrail is architectural — keep the
agent read-only so its output *can't* trigger a side effect."

**Q: What's missing, and is that a problem?**
No input sanitization and no human-in-the-loop gate. Both are fine for a
single-user, local, read-only tool — there's no untrusted user and no
action to gate. They'd become required the moment a writing/acting tool
is added (the two-brain phone design), at which point I'd add output
schema validation and a human gate on irreversible actions.

## See also

- `01-reasoning-patterns/02-agent-loop-skeleton.md` — the budget exit as
  a loop mechanic
- `03-multi-agent-orchestration/07-graph-orchestration.md` — what makes
  a human gate resumable
- `04-agent-infrastructure/03-tool-calling-and-mcp.md` — the
  emits-intent boundary
- `.aipe/study-security/03-indirect-prompt-injection-surface.md` and
  `.aipe/study-security/04-least-privilege-tool-scope.md` — the security
  view of the same controls
