import type { Context } from "@netlify/functions";
import { listToolsByIntegration, executeTool } from "./lib/tools/registry";
import { registerGitHubTools } from "./lib/tools/github";
import { registerNotionTools } from "./lib/tools/notion";
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

// Register all tools on cold start
registerGitHubTools();
registerNotionTools();

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
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default async function handler(req: Request, _context: Context) {
  const url = new URL(req.url);

  try {
    // GET /tools — list all integrations (built-in + custom) with status + tools
    if (req.method === "GET" && !url.searchParams.has("execute")) {
      const [configs, customIntegrations] = await Promise.all([
        listToolConfigs(),
        listCustomIntegrations(),
      ]);
      const configMap = new Map(configs.map((c) => [c.integrationId, c]));

      // Built-in integrations
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

          // Special case: GitHub uses env var
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

      // Custom integrations
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

    // POST /tools?execute — execute a tool by name
    if (req.method === "POST" && url.searchParams.has("execute")) {
      const body = await req.json();
      const { toolName, input } = body as {
        toolName: string;
        input: Record<string, unknown>;
      };

      if (!toolName) {
        return json({ error: "toolName is required" }, 400);
      }

      const result = await executeTool(toolName, input || {});
      return json(result, result.ok ? 200 : 400);
    }

    // POST /tools?create — create a custom integration
    if (req.method === "POST" && url.searchParams.has("create")) {
      const body = await req.json();
      const { name, description, configFields } = body as {
        name: string;
        description: string;
        configFields: { key: string; label: string; secret: boolean }[];
      };

      if (!name?.trim()) {
        return json({ error: "name is required" }, 400);
      }

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

    // PUT /tools?integrationId=xxx — save config for an integration
    if (req.method === "PUT") {
      const integrationId = url.searchParams.get("integrationId");
      if (!integrationId) {
        return json({ error: "integrationId is required" }, 400);
      }

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

    // DELETE /tools?integrationId=xxx — remove config (and custom integration if applicable)
    if (req.method === "DELETE") {
      const integrationId = url.searchParams.get("integrationId");
      if (!integrationId) {
        return json({ error: "integrationId is required" }, 400);
      }

      await deleteToolConfig(integrationId);

      // If it's a custom integration, delete its definition too
      if (!BUILTIN_INTEGRATIONS[integrationId]) {
        await deleteCustomIntegration(integrationId);
      }

      return json({ ok: true });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    console.error("tools function error:", err);
    return json({ error: "Internal server error" }, 500);
  }
}
