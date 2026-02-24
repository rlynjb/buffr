import { registerTool } from "./registry";

const INTEGRATION_ID = "notion";

export function registerNotionTools() {
  registerTool({
    name: "notion_list_tasks",
    description: "Query tasks from a Notion database",
    integrationId: INTEGRATION_ID,
    inputSchema: {
      type: "object",
      properties: {
        databaseId: { type: "string", description: "Notion database ID" },
        status: { type: "string", description: "Filter by status (optional)" },
      },
      required: ["databaseId"],
    },
    execute: async () => {
      throw new Error("Notion integration not configured. See NOTION_SETUP.md for setup instructions.");
    },
  });

  registerTool({
    name: "notion_get_task",
    description: "Get a single task/page from Notion by ID",
    integrationId: INTEGRATION_ID,
    inputSchema: {
      type: "object",
      properties: {
        pageId: { type: "string", description: "Notion page ID" },
      },
      required: ["pageId"],
    },
    execute: async () => {
      throw new Error("Notion integration not configured. See NOTION_SETUP.md for setup instructions.");
    },
  });

  registerTool({
    name: "notion_update_task",
    description: "Update a task's properties in Notion (status, priority, etc.)",
    integrationId: INTEGRATION_ID,
    inputSchema: {
      type: "object",
      properties: {
        pageId: { type: "string", description: "Notion page ID" },
        properties: { type: "object", description: "Properties to update" },
      },
      required: ["pageId", "properties"],
    },
    execute: async () => {
      throw new Error("Notion integration not configured. See NOTION_SETUP.md for setup instructions.");
    },
  });
}
