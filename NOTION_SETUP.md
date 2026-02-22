# Notion Integration Setup

buffr can pull tasks from a Notion database and surface them as Next Actions on your project page. This guide covers how to set up the connection.

## 1. Create a Notion Integration

1. Go to [notion.so/profile/integrations](https://www.notion.so/profile/integrations)
2. Click **New integration**
3. Select **Internal** (not Public)
4. Name it `buffr` (or anything you like)
5. Select your workspace
6. Under **Content Capabilities**, check **Read content**
7. Click **Submit**
8. Copy the **Internal Integration Secret** — it starts with `ntn_`

## 2. Add Token to Environment

Add the token to your `.env` file:

```
NOTION_TOKEN=ntn_your_token_here
```

## 3. Share Your Database with the Integration

1. Open your tasks database in Notion
2. Click the **...** menu (top right)
3. Go to **Connections** (or **Add connections**)
4. Search for `buffr` and confirm

Without this step, the API will return a 404 even if the database exists.

## 4. Get the Database ID

Open your database as a full page in Notion. The URL looks like:

```
https://www.notion.so/your-workspace/abc123def456789...?v=...
```

The database ID is the 32-character hex string after the workspace name and before `?v=`.

Example:
- URL: `https://www.notion.so/myworkspace/a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4?v=...`
- Database ID: `a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4`

## 5. Expected Table Structure

Your Notion database should have these properties:

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| **Name** (or title column) | Title | Yes | The task name — this is the default first column |
| **Status** | Status or Select | Yes | Task status (e.g., "To Do", "In Progress", "Done") |
| **Priority** | Select | No | Priority level (e.g., "High", "Medium", "Low") |
| **Tags** | Multi-select | No | Labels or categories |

The property names are configurable in the backend config (see below). If your columns have different names, just update the mappings.

## 6. Configure in Code

The Notion config lives in `netlify/functions/lib/notion.ts`. Edit this file to match your setup:

```typescript
export const NOTION_CONFIG = {
  // Map your buffr projects to Notion databases.
  // Key: GitHub repo (owner/repo) or project name
  // Value: Notion database ID
  databases: {
    "owner/repo": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
    // Add more projects here...
  } as Record<string, string>,

  // Property name mappings — match your Notion column names exactly.
  // These are case-sensitive.
  properties: {
    title: "Name",        // your title column name
    status: "Status",     // your status column name
    priority: "Priority", // your priority column name (optional)
    tags: "Tags",         // your tags column name (optional)
  },

  // Which status values should appear as "to do" actions
  todoStatuses: ["To Do", "Not Started", "Backlog"],

  // Which status values mean "in progress"
  inProgressStatuses: ["In Progress", "Doing"],

  // Max tasks to fetch per project
  limit: 10,
};
```

### Adding a New Project

To link a new buffr project to a Notion database, add one line to the `databases` map:

```typescript
databases: {
  "owner/existing-repo": "existing-database-id",
  "owner/new-repo": "new-database-id",  // <-- add this
},
```

The key should match either the project's GitHub repo (`owner/repo` format) or the project name.

## How It Works

1. When you open a project page, buffr checks if that project has a Notion database mapped in the config
2. If yes, it fetches tasks where status is in `todoStatuses` or `inProgressStatuses`
3. To-do tasks feed into the **Next Actions** engine alongside GitHub issues, session history, and phase-based suggestions
4. All tasks (to-do + in-progress) appear in a **Notion Tasks** section on the Resume Card
5. If `NOTION_TOKEN` is not set or no database is mapped, everything still works — Notion sections just don't appear

## Troubleshooting

**"NOTION_TOKEN not configured"**
Add `NOTION_TOKEN=ntn_...` to your `.env` file and restart the dev server.

**Empty results even though database has tasks**
- Make sure you shared the database with the integration (Step 3)
- Check that property names in `NOTION_CONFIG.properties` match your column names exactly (case-sensitive)
- Check that status values in `todoStatuses` match your actual status options exactly

**404 error**
- The database wasn't shared with the integration, or the database ID is wrong
- Double-check the ID from the URL (Step 4)
