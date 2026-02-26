import type { Context } from "@netlify/functions";
import { listToolsByIntegration, executeTool } from "./lib/tools/registry";
import { registerGitHubTools } from "./lib/tools/github";
import { registerNotionTools } from "./lib/tools/notion";
import { registerJiraTools } from "./lib/tools/jira";
import {
  listToolConfigs,
  saveToolConfig,
  deleteToolConfig,
} from "./lib/storage/tool-config";
import {
  listCustomIntegrations,
  saveCustomIntegration,
  deleteCustomIntegration,
} from "./lib/storage/custom-integrations";
import type { ToolConfig, ToolIntegration, CustomIntegration } from "../../src/lib/types";
import { json } from "./lib/responses";

// Register all tools on cold start
registerGitHubTools();
registerNotionTools();
registerJiraTools();

// Built-in integration metadata
const BUILTIN_INTEGRATIONS: Record<
  string,
  { name: string; description: string; configFields: ToolIntegration["configFields"] }
> = {
  github: {
    name: "GitHub",
    description: "Repository management, issues, code analysis, and deployment",
    configFields: [
      { key: "token", label: "GitHub Personal Access Token", secret: true },
    ],
  },
  notion: {
    name: "Notion",
    description: "Task management via Notion databases",
    configFields: [
      { key: "token", label: "Notion Integration Token", secret: true },
      { key: "databaseId", label: "Notion Database ID", secret: false },
    ],
  },
  jira: {
    name: "Jira",
    description: "Issue tracking and project management via Jira",
    configFields: [
      { key: "baseUrl", label: "Jira Base URL (e.g. https://yoursite.atlassian.net)", secret: false },
      { key: "email", label: "Jira Account Email", secret: false },
      { key: "apiToken", label: "Jira API Token", secret: true },
      { key: "projectKey", label: "Default Project Key (e.g. PROJ)", secret: false },
    ],
  },
};

// GET — list all integrations with status + tools
async function handleList(): Promise<Response> {
  const [configs, customIntegrations] = await Promise.all([
    listToolConfigs(),
    listCustomIntegrations(),
  ]);
  const configMap = new Map(configs.map((c) => [c.integrationId, c]));

  const builtInList: ToolIntegration[] = Object.entries(BUILTIN_INTEGRATIONS).map(
    ([id, meta]) => {
      const config = configMap.get(id);
      const tools = listToolsByIntegration(id).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));

      let status: ToolIntegration["status"] = "not_configured";
      if (config?.enabled) {
        const requiredFields = meta.configFields.filter((f) => f.key !== "databaseId");
        const allFilled = requiredFields.every(
          (f) => config.values[f.key]?.trim()
        );
        status = allFilled ? "connected" : "error";
      }

      if (id === "github" && !config?.enabled && process.env.GITHUB_TOKEN) {
        status = "connected";
      }

      return {
        id,
        name: meta.name,
        description: meta.description,
        status,
        tools,
        configFields: meta.configFields,
      };
    }
  );

  const customList: ToolIntegration[] = customIntegrations.map((ci) => {
    const config = configMap.get(ci.id);
    let status: ToolIntegration["status"] = "not_configured";
    if (config?.enabled) {
      const allFilled = ci.configFields.every(
        (f) => config.values[f.key]?.trim()
      );
      status = allFilled ? "connected" : "error";
    }

    return {
      id: ci.id,
      name: ci.name,
      description: ci.description,
      status,
      tools: [],
      configFields: ci.configFields,
    };
  });

  return json([...builtInList, ...customList]);
}

// POST ?execute — run a tool by name
async function handleExecute(req: Request): Promise<Response> {
  const body = await req.json();
  const { toolName, input } = body as {
    toolName: string;
    input: Record<string, unknown>;
  };

  if (!toolName) return json({ error: "toolName is required" }, 400);

  const result = await executeTool(toolName, input || {});
  return json(result, result.ok ? 200 : 400);
}

// POST ?create — create a custom integration
async function handleCreate(req: Request): Promise<Response> {
  const body = await req.json();
  const { name, description, configFields } = body as {
    name: string;
    description: string;
    configFields: { key: string; label: string; secret: boolean }[];
  };

  if (!name?.trim()) return json({ error: "name is required" }, 400);

  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  if (BUILTIN_INTEGRATIONS[id]) {
    return json({ error: `"${id}" conflicts with a built-in integration` }, 400);
  }

  const integration: CustomIntegration = {
    id,
    name: name.trim(),
    description: description?.trim() || "",
    configFields: configFields || [],
    createdAt: new Date().toISOString(),
  };

  const saved = await saveCustomIntegration(integration);
  return json(saved);
}

// PUT ?integrationId=xxx — save config
async function handleSaveConfig(req: Request, integrationId: string): Promise<Response> {
  const body = await req.json();
  const { values, enabled } = body as {
    values: Record<string, string>;
    enabled: boolean;
  };

  const config: ToolConfig = {
    integrationId,
    values: values || {},
    enabled: enabled ?? true,
    updatedAt: new Date().toISOString(),
  };

  const saved = await saveToolConfig(config);
  return json(saved);
}

// DELETE ?integrationId=xxx — remove config + custom integration
async function handleDelete(integrationId: string): Promise<Response> {
  await deleteToolConfig(integrationId);

  if (!BUILTIN_INTEGRATIONS[integrationId]) {
    await deleteCustomIntegration(integrationId);
  }

  return json({ ok: true });
}

export default async function handler(req: Request, _context: Context) {
  const url = new URL(req.url);

  try {
    if (req.method === "GET") return handleList();

    if (req.method === "POST") {
      if (url.searchParams.has("execute")) return handleExecute(req);
      if (url.searchParams.has("create")) return handleCreate(req);
    }

    if (req.method === "PUT") {
      const integrationId = url.searchParams.get("integrationId");
      if (!integrationId) return json({ error: "integrationId is required" }, 400);
      return handleSaveConfig(req, integrationId);
    }

    if (req.method === "DELETE") {
      const integrationId = url.searchParams.get("integrationId");
      if (!integrationId) return json({ error: "integrationId is required" }, 400);
      return handleDelete(integrationId);
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    console.error("tools function error:", err);
    return json({ error: "Internal server error" }, 500);
  }
}
