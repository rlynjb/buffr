# buffr

A lightweight developer continuity and momentum tool. Flow preserver, setup eliminator, and structured idea helper.

## Tech Stack

- Next.js + TypeScript
- Tailwind CSS
- Netlify Functions (serverless API)
- Netlify Blobs (storage)
- LangChain.js (AI plan generation)
- Octokit (GitHub API)

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
  app/           — Next.js App Router pages
  components/    — React components (ui, flow, session, dashboard)
  context/       — React context providers
  lib/           — Types, API client, utilities
  hooks/         — Custom React hooks
netlify/
  functions/     — Serverless API (CRUD, AI, scaffold, deploy)
    lib/ai/      — LangChain chains and provider factory
    lib/storage/ — Netlify Blobs storage layer
```
