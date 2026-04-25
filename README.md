# buffr

A lightweight developer continuity and momentum tool. Flow preserver, setup eliminator, and structured idea helper.

## Tech Stack

- Next.js + TypeScript
- Tailwind CSS
- Netlify Functions (serverless API)
- Neon Postgres via Drizzle ORM
- LangChain.js (session summaries, intent detection, task paraphrasing)

## Setup

```bash
npm install
cp .env.example .env
# Edit .env with your API keys
```

## Development

```bash
# With Netlify CLI (recommended — enables Functions + Blobs locally)
netlify dev

# Or Next.js only (no backend functions)
npm run dev
```

## Environment Variables

See `.env.example` for all required variables. At minimum, configure one LLM provider (Anthropic, OpenAI, Google, or Ollama).

## Project Structure

```
src/
  app/           — Next.js App Router pages (login, dashboard, project workspace)
  components/    — React components (ui, dashboard, session, tools)
  context/       — Auth + LLM-provider context providers
  lib/           — Types, API client, utilities
netlify/
  functions/     — Serverless API (auth, projects, sessions, manual-actions, AI, tools)
    lib/ai/      — LangChain chains + provider factory
    lib/storage/ — Drizzle-backed Postgres data access
    lib/db/      — Drizzle schema + client
    lib/tools/   — Tool registry + GitHub tools
drizzle/         — Postgres migrations
```

For the full spec, see [SPEC.md](SPEC.md).
