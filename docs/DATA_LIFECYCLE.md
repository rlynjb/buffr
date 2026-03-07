# Data Lifecycle

How data flows through buffr — from frontend to storage, external APIs, and back.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  FRONTEND (Next.js 16)                                  │
│  localhost:3000 (dev) / yoursite.netlify.app (prod)     │
│                                                         │
│  src/lib/api.ts → fetch("/.netlify/functions/...")       │
└──────────────────────┬──────────────────────────────────┘
                       │ HTTP
┌──────────────────────▼──────────────────────────────────┐
│  NETLIFY FUNCTIONS (serverless)                         │
│  netlify/functions/*.ts                                 │
│                                                         │
│  /projects  /sessions  /prompts  /providers             │
│  /generate-dev  /scan-results  /industry-kb             │
│  /tools  /run-prompt  /session-ai  /action-notes        │
└───┬──────────────┬──────────────────┬───────────────────┘
    │              │                  │
    ▼              ▼                  ▼
┌────────┐  ┌───────────┐  ┌──────────────────┐
│NETLIFY │  │ GITHUB    │  │ LLM PROVIDERS    │
│BLOBS   │  │ API       │  │ (Anthropic,      │
│(9 KV   │  │           │  │  OpenAI, Google,  │
│stores) │  │ repo scan │  │  Ollama)          │
│        │  │ file push │  │                   │
│        │  │ issues    │  │ analysis, prompts │
└────────┘  └───────────┘  └──────────────────┘
```

---

## Storage: Netlify Blobs (9 stores)

No database. All state lives in Netlify Blobs key-value stores.

| Store | Key | Contents |
|-------|-----|----------|
| `projects` | `{uuid}` | Project metadata, githubRepo, phase, goals |
| `sessions` | `{uuid}` | Chat sessions tied to projects |
| `prompt-library` | `{uuid}` | Prompt templates (library + .dev/) |
| `scan-results` | `{uuid}` | .dev/ scan output (stack, gaps, generated files) |
| `industry-kb` | `{technology}` | Best practices per tech (react, nextjs, etc.) |
| `industry-kb-meta` | `{technology}` | KB metadata (version, seed date) |
| `settings` | `{key}` | App settings (e.g., default-data-sources) |
| `action-notes` | `{projectId}` | Per-project action notes |
| `tool-config` | `{integrationId}` | GitHub/Notion/Jira integration configs |

**Storage pattern:** All stores use `getStore(STORE_NAME)` from `@netlify/blobs`.

```
s.get(key, { type: "text" })  → JSON string
s.set(key, JSON.stringify(v)) → write
s.list()                      → { blobs: [{ key }, ...] }
s.delete(key)                 → remove
```

**Known limitation:** List operations fetch ALL blobs then filter in-memory. Fine for small datasets, needs indexed storage at scale.

---

## External Data Sources

### GitHub API

- **Base:** `https://api.github.com`
- **Auth:** `GITHUB_TOKEN` env var (PAT with repo scope)
- **Used by:** `netlify/functions/lib/github.ts`

| Operation | Function | When |
|-----------|----------|------|
| Detect stack | `analyzeRepo()` | Scan: Phase 1 |
| Repo metadata | `getRepoInfo()` | Scan: Phase 1 |
| Recent commits | `getCommits()` | Scan: Phase 1 |
| Read file | `getFileContent()` | Scan: config parsing |
| File tree | GitHub Trees API | Scan: Phase 1 |
| Push .dev/ | `pushFiles()` | Scan: Phase 4 + manual push |
| Issues | `getIssues()`, `createIssue()`, `closeIssue()` | Tool calls |
| Repos | `getUserRepos()` | Tool calls |
| Diffs | `getDiffs()` | Tool calls |

### LLM Providers (via LangChain)

| Provider | Env Vars | Default Model |
|----------|----------|---------------|
| Anthropic | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | `claude-sonnet-4-20250514` |
| OpenAI | `OPENAI_API_KEY`, `OPENAI_MODEL` | `gpt-4o` |
| Google | `GOOGLE_API_KEY`, `GOOGLE_MODEL` | `gemini-1.5-pro` |
| Ollama | `OLLAMA_BASE_URL`, `OLLAMA_MODEL` | `llama3` |

- `DEFAULT_LLM_PROVIDER` env var selects the default (falls back to `anthropic`)
- Only providers with keys set appear in the UI provider switcher
- If LLM is unavailable, `generate-dev` falls back to rule-based analysis

### Optional Integrations

| Integration | Env Vars | Status Logic |
|-------------|----------|--------------|
| Notion | `NOTION_TOKEN`, `NOTION_DATABASE_ID` | env set → connected, else check `tool-config` store |
| Jira | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY` | same |
| GitHub | `GITHUB_TOKEN` | same |

---

## Key Data Flows

### Scan Repository → Generate .dev/

```
Frontend                     Backend (generate-dev.ts)              External
────────                     ───────────────────────               ────────
triggerScan(projectId)
  POST /generate-dev ──────► Load project from Blobs
                              │
                              ├─► GitHub: analyzeRepo()  ──────► github.com
                              ├─► GitHub: getCommits()   ──────► github.com
                              ├─► GitHub: getFileContent()────► github.com
                              ├─► GitHub: Trees API      ──────► github.com
                              │
                              │   status: "scanning" → "analyzing"
                              │
                              ├─► seedIndustryKB()       ──────► industry-kb store
                              ├─► listStandards()        ──────► industry-kb store
                              │
                              ├─► LLM: runDevScan()      ──────► LLM provider
                              │   (or rule-based fallback)
                              │
                              │   status: "analyzing" → "generating"
                              │
                              ├─► buildGeneratedFiles()
                              │   (23 files in .dev/ structure)
                              │
                              │   status: "generating" → push
                              │
                              ├─► GitHub: pushFiles()    ──────► github.com
                              │
                              ├─► Save ScanResult       ──────► scan-results store
                              ├─► Update Project        ──────► projects store
                              │
  ◄──────── ScanResult JSON   │   status: "done"
```

### Session AI (summarize / intent / next steps)

```
Frontend                     Backend                    External
────────                     ───────                    ────────
POST /session-ai ──────────► Load session from Blobs
                              ├─► LLM chain            ──────► LLM provider
                              ├─► Save session          ──────► sessions store
  ◄──────── Result JSON
```

### Run Prompt

```
Frontend                     Backend                    External
────────                     ───────                    ────────
POST /run-prompt ──────────► Load prompt from Blobs
                              ├─► Resolve tools
                              ├─► LLM: prompt chain    ──────► LLM provider
                              │   (may call GitHub/     ──────► github.com
                              │    Notion/Jira tools)   ──────► notion.so / jira
  ◄──────── Result JSON
```

---

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `GITHUB_TOKEN` | Yes | GitHub API access (repo scan, push, issues) |
| `ANTHROPIC_API_KEY` | One LLM required | Claude access |
| `OPENAI_API_KEY` | One LLM required | GPT access |
| `GOOGLE_API_KEY` | Optional | Gemini access |
| `OLLAMA_BASE_URL` | Optional | Local LLM |
| `DEFAULT_LLM_PROVIDER` | No (default: anthropic) | Which LLM to use by default |
| `NOTION_TOKEN` | Optional | Notion integration |
| `NOTION_DATABASE_ID` | Optional | Notion database for tasks |
| `JIRA_BASE_URL` | Optional | Jira instance |
| `JIRA_EMAIL` | Optional | Jira auth |
| `JIRA_API_TOKEN` | Optional | Jira auth |
| `JIRA_PROJECT_KEY` | Optional | Default Jira project |

---

## Sync: Prod ↔ Local

Netlify Blobs are **environment-scoped** — local dev and prod have isolated stores.

### Pull prod → local

```bash
# List keys in a prod store
netlify blobs:list --store projects --context production

# Pull a specific blob
netlify blobs:get --store projects <key> --context production > /tmp/blob.json

# Write into local dev store
netlify blobs:set --store projects <key> --input /tmp/blob.json
```

### Push local → prod

```bash
netlify blobs:get --store projects <key> > /tmp/blob.json
netlify blobs:set --store projects <key> --input /tmp/blob.json --context production
```

### Bulk sync script

```bash
#!/bin/bash
# sync-blobs.sh — Sync all data between environments
# Usage: ./sync-blobs.sh [pull|push] [store-name]

DIRECTION=${1:-pull}  # pull = prod→local, push = local→prod
STORE=${2:-all}
STORES=("projects" "sessions" "prompt-library" "scan-results" \
        "industry-kb" "industry-kb-meta" "settings" "action-notes" "tool-config")

if [ "$STORE" != "all" ]; then
  STORES=("$STORE")
fi

for store in "${STORES[@]}"; do
  echo "--- Syncing store: $store ---"

  if [ "$DIRECTION" = "pull" ]; then
    keys=$(netlify blobs:list --store "$store" --context production --json | jq -r '.[].key')
    for key in $keys; do
      echo "  Pulling $store/$key"
      netlify blobs:get --store "$store" "$key" --context production > /tmp/blob.json
      netlify blobs:set --store "$store" "$key" --input /tmp/blob.json
    done
  else
    keys=$(netlify blobs:list --store "$store" --json | jq -r '.[].key')
    for key in $keys; do
      echo "  Pushing $store/$key"
      netlify blobs:get --store "$store" "$key" > /tmp/blob.json
      netlify blobs:set --store "$store" "$key" --input /tmp/blob.json --context production
    done
  fi
done
```

### What does NOT need syncing

- **GitHub data** — fetched live from GitHub API on every scan
- **LLM responses** — transient, not cached
- **Industry KB** — auto-seeded on first scan via `seedIndustryKB()`
- **Environment variables** — set separately in Netlify dashboard (prod) and `.env` (local)
