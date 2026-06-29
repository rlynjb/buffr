# jsx-to-esm-build

*Automatic JSX runtime + tsc → ESM · the build toolchain · Industry standard*

## Zoom out, then zoom in

In a browser project the build is usually Vite or Webpack: JSX in, a bundle out, served to
the browser. Here there is no bundler at all. The whole build is `tsc` compiling your
`.tsx` to `.js`, and Node runs the emitted file directly. Two compiler settings do all the
load-bearing work: `jsx: "react-jsx"` (how JSX becomes function calls) and `module:
"NodeNext"` (what kind of module the output is). That's the entire toolchain.

```
  Zoom out — where the build sits

  ┌─ Source ────────────────────────────────────────────────────┐
  │  src/cli/chat.tsx   (JSX + TypeScript)                       │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  ★ tsc -p tsconfig.json ★   (the whole build)
  ┌─ Compile ─────────────────────▼──────────────────────────────┐
  │  jsx: "react-jsx"   → JSX becomes jsx() calls                │ ← we are here
  │  module: "NodeNext" → output is ESM (import/export)          │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  emit
  ┌─ Run ─────────────────────────▼──────────────────────────────┐
  │  node dist/src/cli/chat.js     (no bundler, no transpile@run)│
  └──────────────────────────────────────────────────────────────┘
```

**Zoom in.** The pattern is **compile-not-bundle**: TypeScript is the only build step, JSX
is lowered by the *automatic runtime* (so you never `import React`), and the output is plain
ESM that Node executes from disk. The question: *how does `<Chat session={…}/>` in a `.tsx`
file become something Node can run, with no Babel, no Vite, no bundle step?*

## Structure pass

One axis: **lifecycle — when does each thing happen: build / run?** This is the right axis
because the whole story is "what `tsc` does at build vs what Node does at run."

```
  One axis — "when does it happen?" — across the toolchain

  ┌─ build time  (tsc) ───────────────────────────────────┐
  │  JSX → jsx() calls          (jsx: react-jsx)          │  → happens ONCE
  │  .tsx → .js                 (module: NodeNext → ESM)  │
  │  types checked, then erased                          │
  └───────────────────────────────────────────────────────┘
            ═══════════ emit to dist/ ═══════════  (lifecycle flips: build → run)
  ┌─ run time  (node) ────────────────────────────────────┐
  │  import './session.js'      (ESM resolution)          │  → happens EACH run
  │  jsx() executes → React elements → ink renders        │
  └───────────────────────────────────────────────────────┘
```

- **Layers:** source `.tsx` → `tsc` (build) → `dist/` `.js` → `node` (run).
- **Axis:** lifecycle. JSX-lowering and type-checking are *build-time, once*. Module
  resolution and JSX-call execution are *run-time, every launch*.
- **The load-bearing seam:** the emit boundary (`dist/`). Build-time concerns (JSX syntax,
  types) do not exist past it; run-time concerns (ESM `import`, `.js` extensions) begin there.
  *The two settings that govern this seam are `jsx` and `module`* — get either wrong and the
  emitted file either won't construct elements or won't import.

## How it works

### Move 1 — the mental model

You know that `<Chat/>` isn't real JavaScript — something has to turn it into a function
call. In the *classic* runtime that call was `React.createElement(Chat)`, which is why old
files needed `import React`. The *automatic* runtime (`react-jsx`) changes the lowering so it
imports a `jsx()` helper for you, behind the scenes. The shape:

```
  The pattern — JSX lowering, classic vs automatic

  you write:   <Text color="cyan">{'> '}</Text>

  classic  (jsx: "react"):       automatic  (jsx: "react-jsx"):
  ─────────────────────────      ──────────────────────────────
  needs:  import React           needs:  nothing (auto-injected)
  emits:  React.createElement(   emits:  import { jsx } from
            Text,                          'react/jsx-runtime';
            {color:'cyan'},                jsx(Text, {color:'cyan',
            '> ')                              children:'> '})
```

The strategy: **the compiler injects the JSX helper import itself, so your source never
mentions React, and the output is a normal module.** That's why `chat.tsx:1` imports only
`useState` — no `import React` anywhere.

### Move 2 — the walkthrough

#### `jsx: "react-jsx"` — the automatic runtime, no React import

```jsonc
// tsconfig.json:13
"jsx": "react-jsx",
```

This one setting is why the very first line of the component is just:

```tsx
// src/cli/chat.tsx:1
import { useState } from 'react';   // note: NO `import React from 'react'`
```

Under `react-jsx`, `tsc` compiles every JSX element into a call to a `jsx()` (or `jsxs()` for
multiple children) helper that it imports from `react/jsx-runtime` automatically. You never
write that import; the compiler injects it. The boundary condition: if this were set to the
classic `"react"` instead, every `.tsx` file would need `import React` at the top or the
emitted `React.createElement` calls would reference an undefined `React` and crash at run
time. The automatic runtime removes that footgun entirely.

#### `module: "NodeNext"` — emit ESM, resolve like Node

```jsonc
// tsconfig.json:4-5
"module": "NodeNext",
"moduleResolution": "NodeNext",
```

This makes `tsc` emit ES modules (`import`/`export`, not `require`) and resolve imports the
way Node's ESM loader does. It pairs with `"type": "module"` in `package.json:4`, which tells
Node to treat `.js` files as ESM. The visible consequence is in the import specifiers:

```tsx
// src/cli/chat.tsx:5
import { createChatSession, type ChatSession } from '../session.js';
//                                                            ^^^ .js, not .ts
```

You import `'../session.js'` — the `.js` extension, even though the source file is
`session.ts`. That is NodeNext's rule: ESM requires *explicit file extensions*, and you write
the extension of the *emitted* file (`.js`), because that's what exists at run time in
`dist/`. The boundary condition: drop the `.js` extension and Node's ESM loader throws
`ERR_MODULE_NOT_FOUND` at run time — TypeScript would compile it fine, but the emitted import
would be unresolvable. This is the single most common ESM-in-Node papercut, and NodeNext
enforces getting it right.

```
  Layers-and-hops — a source import across the build seam

  ┌─ build (tsc) ─────┐  emit, extension kept  ┌─ run (node ESM) ──────┐
  │ chat.tsx:5        │ ──────────────────────►│ dist/.../chat.js      │
  │ from '../session  │                        │ import '../session.js'│
  │      .js'         │   types erased         │ resolves to           │
  │                   │                        │ dist/src/session.js   │
  └───────────────────┘                        └───────────────────────┘
```

#### The build script — one command, then run from `dist/`

```jsonc
// package.json:7,12
"build": "tsc -p tsconfig.json",
"chat":  "npm run build && node dist/src/cli/chat.js",
```

`npm run chat` (the sole interface) builds with `tsc`, then runs the emitted entry from
`dist/`. There is no bundler in the chain — no Vite, Webpack, esbuild, no Babel. The
`rootDir: "."` + `outDir: "dist"` (`tsconfig.json:8-9`) mirror the source tree into `dist/`,
so `src/cli/chat.tsx` emits to `dist/src/cli/chat.js`. The `include` globs
(`tsconfig.json:16`) cover `src/**/*.tsx` so the `.tsx` file is compiled alongside the `.ts`
ones. The boundary condition: because Node runs the emitted `.js` directly, there is no
transpile-at-startup cost and no source map step configured — what `tsc` writes is exactly
what runs.

#### What's NOT in the build (named honestly)

```
  browser build pipeline          this build
  ──────────────────────          ──────────
  bundler (Vite/Webpack)    →     none — node runs .js directly
  tree-shaking              →     n/a — no bundle to shake
  code-splitting            →     n/a — one entry, one process
  polyfills                 →     n/a — targets Node ES2022 (tsconfig:3)
  sourcemaps                →     not configured
  minification              →     n/a — server-side, no transfer size
```

None of these apply because the artifact is a Node process reading `.js` from disk, not a
bundle shipped over the wire to a browser. `target: "ES2022"` (`tsconfig.json:3`) sets the
language level to what Node 20 already supports natively, so there is nothing to down-level.

### Move 3 — the principle

**For server-side TypeScript, compile is the whole build — a bundler is a browser concern.**
Bundling, tree-shaking, and code-splitting all exist to minimize *bytes shipped over a
network to a browser*. A Node process reading files from local disk has no transfer-size
problem, so the entire bundler layer drops away and `tsc` alone is the toolchain. The two
settings that carry the weight are framework-agnostic substrate: `jsx` decides how JSX
lowers, `module` decides what module system you emit into — and the `.js`-extension rule is
the ESM tax you pay for getting NodeNext's correctness.

## Primary diagram

The complete pipeline, build-time and run-time split at the emit seam.

```
  jsx-to-esm-build — the complete frame

  ┌─ Source (src/) ──────────────────────────────────────────────┐
  │  chat.tsx :1  import { useState }  (no React import)         │
  │  chat.tsx :5  from '../session.js'  (.js extension)          │
  │  JSX: <Chat/> <Box/> <Text/> <TextInput/> <Spinner/>        │
  └───────────────────────────────┬──────────────────────────────┘
            tsc -p tsconfig.json    │  (package.json:7)
  ┌────────────────────────────────▼─────────────────────────────┐
  │  BUILD TIME                                                  │
  │   jsx:"react-jsx"  → inject jsx() from react/jsx-runtime     │  tsconfig:13
  │   module:"NodeNext"→ emit ESM, keep .js extensions           │  tsconfig:4-5
  │   target:"ES2022"  → no down-levelling (Node 20 native)      │  tsconfig:3
  │   types checked, then ERASED                                 │
  └───────────────────────────────┬──────────────────────────────┘
            emit to dist/          │  ═══ build → run seam ═══
  ┌────────────────────────────────▼─────────────────────────────┐
  │  RUN TIME   node dist/src/cli/chat.js   (package.json:12)    │
  │   "type":"module" → Node treats .js as ESM   (package.json:4)│
  │   jsx() executes → React elements → ink paints terminal      │
  │   NO bundler · NO tree-shake · NO sourcemaps · NO polyfills  │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

The automatic JSX runtime arrived with React 17 specifically to kill the `import React from
'react'` boilerplate (and to let bundlers import only the JSX helper rather than all of
React). For a terminal app it has a second nice property: the lowering targets
`react/jsx-runtime`, which is host-agnostic, so the same compiled output works whether the
renderer underneath is `react-dom` or `ink` — the build doesn't bake in the host. The
NodeNext module mode is the more recent piece; it exists because Node's native ESM loader is
stricter than bundler resolution (mandatory extensions, no directory-index magic), and
NodeNext makes `tsc` enforce those rules at compile time so you don't discover them as
runtime crashes. If this app ever grew a browser surface, *that* is when a bundler would
enter the picture — and `study-performance-engineering` would finally have a bundle size to
measure. Today there is none.

## Interview defense

**Q: There's no `import React` anywhere — how does the JSX even work?**

```
  jsx: "react-jsx"  (automatic runtime)

  source:   <Text color="cyan">…</Text>     (no React in scope)
              │ tsc lowers
              ▼
  emitted:  import { jsx } from 'react/jsx-runtime';   ← compiler injects this
            jsx(Text, { color: 'cyan', children: … })
```

The `jsx: "react-jsx"` setting (`tsconfig.json:13`) tells `tsc` to use the automatic runtime:
it lowers each JSX element to a `jsx()` call and *injects the import of that helper itself*,
from `react/jsx-runtime`. So the source never needs `import React` — note `chat.tsx:1` imports
only `useState`. Under the old classic runtime it would compile to `React.createElement` and
require React in scope. Anchor: *"the automatic runtime injects the jsx() import, so JSX works
with no React import in the file."*

**Q: Why do the imports end in `.js` when the files are `.ts`?**

Because `module: "NodeNext"` (`tsconfig.json:4`) emits real ESM, and Node's ESM loader
requires explicit file extensions on relative imports. You write the extension of the
*emitted* file — `.js`, the thing that exists in `dist/` at run time — not the source `.ts`.
Drop it and the compile passes but Node throws `ERR_MODULE_NOT_FOUND` at startup. It's the
classic NodeNext papercut, and the import at `chat.tsx:5` (`from '../session.js'`) is the
exact spot it shows. Anchor: *"NodeNext emits ESM, ESM demands extensions, and you write the
emitted `.js` extension, not the source `.ts`."*

## See also

- `01-react-without-the-dom.md` — what the lowered `jsx()` calls construct (React elements
  for Ink).
- `00-overview.md` — where this build sits in the whole surface.
- Cross-link: `study-runtime-systems` — Node's ESM loader and the event loop the emitted
  module runs on.
- Cross-link: `study-performance-engineering` — bundle-size measurement (nothing to measure
  here; no bundle).
