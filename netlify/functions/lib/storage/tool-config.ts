import { getStore } from "@netlify/blobs";
import type { ToolConfig } from "../../../../src/lib/types";
import { dbWrite } from "./db/write-guard";
import { upsertToolConfig, deleteToolConfigDb } from "./db/tool-configs";

const STORE_NAME = "tool-config";

function store() {
  return getStore(STORE_NAME);
}

export async function listToolConfigs(): Promise<ToolConfig[]> {
  const s = store();
  const { blobs } = await s.list();
  const configs: ToolConfig[] = [];
  for (const blob of blobs) {
    const data = await s.get(blob.key, { type: "text" });
    if (data) {
      configs.push(JSON.parse(data) as ToolConfig);
    }
  }
  return configs;
}

export async function saveToolConfig(config: ToolConfig): Promise<ToolConfig> {
  const s = store();
  config.updatedAt = new Date().toISOString();
  await s.set(config.integrationId, JSON.stringify(config));
  await dbWrite("saveToolConfig", () => upsertToolConfig(config));
  return config;
}

export async function deleteToolConfig(integrationId: string): Promise<void> {
  const s = store();
  await s.delete(integrationId);
  await dbWrite("deleteToolConfig", () => deleteToolConfigDb(integrationId));
}
