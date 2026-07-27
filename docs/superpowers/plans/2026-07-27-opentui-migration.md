# OpenTUI Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Ink (inactive React-in-terminal renderer) with OpenTUI's React reconciler (`@opentui/react`) in buffr's CLI chat command, preserving all existing behavior.

**Architecture:** `src/session.ts` and the `ChatSession` interface are frozen — they are the clean seam between UI and data and must not change. `src/cli/chat.tsx` is fully rewritten to use OpenTUI's primitive JSX elements (`<box>`, `<text>`, `<input>`) via `@opentui/react` instead of Ink's capitalized components. The `npm run chat` script changes its runner from `node` to `bun` because OpenTUI's Zig FFI core requires Bun (`bun:ffi`). All other scripts and the build pipeline stay on Node.js + tsc.

**Tech Stack:** `@opentui/core` (native renderer core), `@opentui/react` (React reconciler for OpenTUI), `react@^18.3.1`, TypeScript 5, tsc (build), Bun (runtime — `npm run chat` only)

## Global Constraints

- `src/session.ts`: zero changes — `ChatSession` and `createChatSession()` are frozen
- All other scripts (`build`, `test`, `index`, `eval`, `migrate`): continue using `node` unchanged
- `.tsx` extension is kept — we still have JSX; only the import sources change
- Preserve exact UX: turn history display, `/exit` and `/quit` commands, spinner while agent thinks, errors displayed as buffr turns
- Bun must be installed on the host: `bun --version` (install from https://bun.sh if absent)
- OpenTUI's renderer requires the `bun` runtime — compiled JS for chat must be run with `bun`, not `node`

---

### Task 1: Install Bun and verify existing build

**Files:**
- No source changes

**Interfaces:**
- Produces: `bun` available on PATH; `npm run build` still exits 0

- [ ] **Step 1: Install Bun**

```bash
curl -fsSL https://bun.sh/install | bash
```

Restart your shell (or `source ~/.zshrc`) so `bun` lands on PATH.

- [ ] **Step 2: Confirm Bun is installed**

Run: `bun --version`
Expected: version string, e.g. `1.1.x`

- [ ] **Step 3: Verify the existing build is clean before any changes**

```bash
cd /Users/rein/Public/buffr && npm run build
```

Expected: exits 0, no TypeScript errors. This is your baseline.

---

### Task 2: Swap Ink packages for OpenTUI packages

**Files:**
- Modify: `package.json` (via npm commands)

**Interfaces:**
- Produces: `@opentui/core` and `@opentui/react` in `node_modules`; Ink packages absent

- [ ] **Step 1: Uninstall Ink packages**

```bash
npm uninstall ink ink-spinner ink-text-input
```

Expected: `package.json` no longer lists `ink`, `ink-spinner`, `ink-text-input` under `dependencies`.

- [ ] **Step 2: Install OpenTUI packages**

```bash
npm install @opentui/core @opentui/react
```

Expected: both packages appear in `package.json` `"dependencies"`.

- [ ] **Step 3: Verify package.json dependencies**

The `"dependencies"` block should now be:

```json
{
  "@opentui/core": "^0.4.5",
  "@opentui/react": "^0.4.5",
  "@rlynjb/aptkit-core": "^0.4.1",
  "dotenv": "^16.4.0",
  "pg": "^8.11.0",
  "react": "^18.3.1"
}
```

`"devDependencies"` stays:

```json
{
  "@types/node": "^20.0.0",
  "@types/pg": "^8.11.0",
  "@types/react": "^18.3.0",
  "typescript": "^5.4.0"
}
```

No `ink`, `ink-spinner`, `ink-text-input` anywhere.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: replace ink with @opentui/core and @opentui/react"
```

---

### Task 3: Rewrite src/cli/chat.tsx

**Files:**
- Modify: `src/cli/chat.tsx` (full rewrite, same filename)

**Interfaces:**
- Consumes: `createChatSession, type ChatSession` from `'../session.js'` (unchanged)
- Consumes: `createCliRenderer` from `'@opentui/core'`
- Consumes: `createRoot` from `'@opentui/react'`
- Consumes: `useState, useEffect` from `'react'`
- Produces: identical UX — turn history, busy spinner, `/exit`/`/quit`, error turns

**Ink → OpenTUI React translation table:**

| Ink | OpenTUI React |
|-----|---------------|
| `import { render, Box, Text, useApp } from 'ink'` | `createCliRenderer` + `createRoot` |
| `<Box flexDirection="column">` | `<box flexDirection="column">` (lowercase) |
| `<Text color="cyan">` | `<text fg="#00FFFF">` |
| `<Text bold>` | `<text bold>` |
| `<Text dimColor>` | `<text fg="#888888">` |
| `<TextInput value={v} onChange={set} onSubmit={fn} />` | `<input placeholder="..." onSubmit={fn} focused />` (uncontrolled — value clears on unmount/remount) |
| `<Spinner type="dots" />` | custom `<Spinner>` using `setInterval` over frame array |
| `useApp().exit()` | `process.exit(0)` after `session.close()` |
| `render(<App />)` | `createRoot(renderer).render(<App />)` |

**Notes on the input/busy cycle:**
When `busy` is `true`, the `<input>` is unmounted and `<Spinner>` appears. When `busy` becomes `false`, a fresh `<input>` mounts with `focused`. This gives a clean empty input after every turn — equivalent to Ink's `setInput('')` pattern, but handled automatically by React's unmount/remount.

- [ ] **Step 1: Replace the entire contents of src/cli/chat.tsx**

```tsx
import { useState, useEffect } from 'react';
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { createChatSession, type ChatSession } from '../session.js';

type Turn = { role: 'you' | 'buffr'; text: string };

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function Spinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame(f => (f + 1) % FRAMES.length), 80);
    return () => clearInterval(id);
  }, []);
  return <text fg="#FFFF00">{FRAMES[frame]} thinking…</text>;
}

function Chat({ session, onExit }: { session: ChatSession; onExit: () => Promise<void> }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (value: string): Promise<void> => {
    const q = value.trim();
    if (busy || !q) return;
    if (q === '/exit' || q === '/quit') {
      await onExit();
      return;
    }
    setTurns(t => [...t, { role: 'you', text: q }]);
    setBusy(true);
    try {
      const answer = await session.ask(q);
      setTurns(t => [...t, { role: 'buffr', text: answer }]);
    } catch (err) {
      setTurns(t => [...t, { role: 'buffr', text: `error: ${(err as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <box flexDirection="column">
      <box marginBottom={1}>
        <text fg="#888888">buffr chat — one conversation, held in-process. Type /exit to quit.</text>
      </box>
      {turns.map((t, i) => (
        <box key={i} flexDirection="column" marginBottom={1}>
          <text bold fg={t.role === 'you' ? '#00FFFF' : '#00FF00'}>{t.role}</text>
          <text>{t.text}</text>
        </box>
      ))}
      {busy ? (
        <Spinner />
      ) : (
        <box>
          <text fg="#00FFFF">{'> '}</text>
          <input placeholder="ask buffr" onSubmit={onSubmit} focused />
        </box>
      )}
    </box>
  );
}

const session = await createChatSession();
const renderer = await createCliRenderer({ exitOnCtrlC: false });

createRoot(renderer).render(
  <Chat
    session={session}
    onExit={async () => {
      await session.close();
      process.exit(0);
    }}
  />,
);
```

- [ ] **Step 2: Build and check for TypeScript errors**

```bash
npm run build
```

If you see errors like `Property 'box' does not exist on type 'JSX.IntrinsicElements'`, the JSX intrinsic types from `@opentui/react` aren't loading automatically. Fix: create `src/cli/opentui.d.ts` with:

```typescript
/// <reference types="@opentui/react" />
```

Then re-run `npm run build`.

- [ ] **Step 3: Confirm dist/src/cli/chat.js is generated**

```bash
ls dist/src/cli/chat.js
```

Expected: file exists with a recent timestamp.

- [ ] **Step 4: Commit**

```bash
git add src/cli/chat.tsx
git commit -m "feat: migrate chat TUI from Ink to @opentui/react"
```

If you created `src/cli/opentui.d.ts` in Step 2, include it:

```bash
git add src/cli/chat.tsx src/cli/opentui.d.ts
git commit -m "feat: migrate chat TUI from Ink to @opentui/react"
```

---

### Task 4: Update the chat script to use Bun

**Files:**
- Modify: `package.json` — `scripts.chat` only

**Interfaces:**
- Consumes: `dist/src/cli/chat.js` (from `npm run build`)
- Produces: `npm run chat` launches via Bun

OpenTUI uses `bun:ffi` to call its Zig rendering core. The `dist/src/cli/chat.js` file must be run with `bun`, not `node`.

- [ ] **Step 1: Change the chat script in package.json**

In `package.json`, change:

```json
"chat": "npm run build && node dist/src/cli/chat.js"
```

to:

```json
"chat": "npm run build && bun dist/src/cli/chat.js"
```

- [ ] **Step 2: Verify all other scripts are unchanged**

The full `"scripts"` block should be:

```json
"scripts": {
  "build": "tsc -p tsconfig.json",
  "test": "npm run build && node --test --test-concurrency=1 dist/test/*.test.js",
  "migrate": "npm run build && node dist/src/migrate.js",
  "index": "npm run build && node dist/src/cli/index-cmd.js",
  "eval": "npm run build && node dist/src/cli/eval-cmd.js",
  "chat": "npm run build && bun dist/src/cli/chat.js"
}
```

Only `chat` uses `bun`. Every other script stays on `node`.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: run chat via bun (required by opentui ffi)"
```

---

### Task 5: Smoke test end-to-end

**Files:**
- No changes

- [ ] **Step 1: Full build**

```bash
npm run build
```

Expected: exits 0.

- [ ] **Step 2: Launch the chat TUI**

```bash
npm run chat
```

Expected: terminal takes over and shows the header and an input prompt:

```
buffr chat — one conversation, held in-process. Type /exit to quit.

> [cursor, "ask buffr" placeholder]
```

- [ ] **Step 3: Submit a question**

Type a question and press Enter. Expected sequence:
1. Your question appears as a `you` turn (cyan label)
2. Spinner `⠋ thinking…` appears in yellow
3. Spinner cycles through frames while the agent runs
4. Answer appears as a `buffr` turn (green label)
5. Fresh empty input line appears, focused

- [ ] **Step 4: Test /exit**

Type `/exit` and press Enter. Expected: terminal exits cleanly with code 0, no stack trace.

- [ ] **Step 5: Test /quit**

Run `npm run chat` again, type `/quit`, press Enter. Expected: same clean exit.

- [ ] **Step 6: Test error handling**

If you can simulate an error (e.g., temporarily break `.env` DB credentials), run `npm run chat`, ask a question, and verify the error appears as a `buffr` turn with `error: <message>` rather than crashing.

- [ ] **Step 7: Verify non-chat scripts are unaffected**

```bash
npm run test
```

Expected: tests pass (they run with `node`, unaffected by the Bun change).

---

## Self-Review

**Spec coverage:**
- Remove Ink → Task 2 removes all three Ink packages ✓
- Add OpenTUI → Task 2 installs `@opentui/core` and `@opentui/react` ✓
- Rewrite chat.tsx → Task 3 with complete code ✓
- Bun runtime requirement → Task 1 (install) + Task 4 (script change) ✓
- `session.ts` unchanged → no task touches it ✓
- All other scripts (`test`, `index`, `eval`, `migrate`) stay on `node` → Task 4 confirms ✓
- Behavior preserved: turns, spinner, `/exit`, `/quit`, errors → Task 3 code ✓

**Placeholder scan:** No TBDs, no "implement later", no vague steps. All code blocks are complete.

**Type consistency:**
- `ChatSession` type used identically in Task 3 and existing `session.ts`
- `Turn` type defined in Task 3 as `{ role: 'you' | 'buffr'; text: string }` — same shape as the original
- `onExit: () => Promise<void>` matches the implementation `async () => { await session.close(); process.exit(0); }`
- `createCliRenderer`, `createRoot` are direct named imports from published packages — no made-up symbols
