# Etsy API configuration boundary

**Date:** 2026-08-12
**Status:** Approved scaffold only

## Goal

Define the configuration boundary for a future read-only Etsy API connector without building the
connector, workflow engine, OAuth flow, or token persistence implementation yet.

## Boundary

```
developer machine
  |
  |  ignored local placeholders
  v
.env
  |
  |  future typed config loader reads only these names
  v
future Etsy connector configuration module
  |
  |  passes sanitized connector settings
  v
future read-only Etsy API connector

workflow engine
  |
  `-- receives connector capabilities/results only
      never raw credentials, OAuth secrets, refresh tokens, or token file contents
```

The local `.env` file is ignored by Git and is the only approved place in this scaffold for
developer-machine Etsy credential placeholders. A future connector configuration module will read
the Etsy-specific environment variables, validate that required values are present, and return
sanitized connector settings. The workflow engine must never read `.env`, inspect `process.env`
for Etsy credential names, receive raw credential strings, or open the token storage file.

## `.env` placeholder names

The ignored local `.env` file should contain obvious non-secret placeholders for:

```dotenv
ETSY_API_KEY=replace-with-etsy-api-key
ETSY_API_SECRET=replace-with-etsy-api-secret
ETSY_OAUTH_CLIENT_ID=replace-with-etsy-oauth-client-id
ETSY_OAUTH_REDIRECT_URI=http://localhost:3000/oauth/etsy/callback
ETSY_OAUTH_SCOPES=shops_r listings_r transactions_r
ETSY_TOKEN_STORAGE_PATH=.local/etsy-token.json
```

`ETSY_TOKEN_STORAGE_PATH` is a local file path for future OAuth token storage. It is not created by
this scaffold; `.gitignore` ignores `.local/` before any future token file exists.

## Out of scope

- No Etsy API client or connector implementation.
- No workflow engine work.
- No OAuth authorization, callback server, token exchange, refresh, or persistence logic.
- No checked-in `.env.example` or sample token file.
- No real credentials in tracked files.

## Done means

- This spec records the credential boundary and explicitly keeps raw credentials away from the
  workflow engine.
- `.gitignore` ignores `.env`.
- The local `.env` contains only obvious Etsy placeholder values for the approved names.
- The commit contains only the tracked design specification and the `.gitignore` rule for future
  local token storage; ignored local env placeholders remain untracked.

## Self-review

- Placeholders: the only placeholder values are intentionally obvious local `.env` examples, not
  unresolved work markers.
- Contradictions: the spec consistently says the future connector configuration module owns
  credential reads, while the workflow engine never accesses raw credentials.
- Ambiguity: token storage is named as a future ignored local path, and no token file is created in
  this scaffold.
- Scope: implementation is limited to documentation and local ignored placeholder configuration.
