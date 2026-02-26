import { registerTool } from "./registry";
import { queryTasks, getTask, createTask, updateTask } from "../notion";

const INTEGRATION_ID = "notion";

export function registerNotionTools() {
  registerTool({
    name: "notion_list_tasks",
    description: "Query tasks from a Notion database",
    integrationId: INTEGRATION_ID,
    inputSchema: {
      type: "object",
      properties: {
        databaseId: { type: "string", description: "Notion database ID (uses default if omitted)" },
        status: { type: "string", description: "Filter by status (optional)" },
      },
    },
    execute: async (input) => {
      const filter = input.status
        ? { property: "Status", status: { equals: input.status as string } }
        : undefined;
      const items = await queryTasks(
        input.databaseId as string | undefined,
        filter,
      );
      return { items };
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
    execute: async (input) => {
      return getTask(input.pageId as string);
    },
  });

  registerTool({
    name: "notion_create_task",
    description: "Create a new task in a Notion database",
    integrationId: INTEGRATION_ID,
    inputSchema: {
      type: "object",
      properties: {
        databaseId: { type: "string", description: "Notion database ID (uses default if omitted)" },
        title: { type: "string", description: "Task title" },
        status: { type: "string", description: "Initial status (optional)" },
      },
      required: ["title"],
    },
    execute: async (input) => {
      return createTask(
        input.databaseId as string | undefined,
        input.title as string,
        input.status as string | undefined,
      );
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
    execute: async (input) => {
      await updateTask(
        input.pageId as string,
        input.properties as Record<string, unknown>,
      );
      return { ok: true };
    },
  });
}
