import { getStore } from "@netlify/blobs";
import type { ToolConfig } from "../../../../src/lib/types";

const STORE_NAME = "tool-config";

function store() {
  return getStore(STORE_NAME);
}

export async function getToolConfig(
  integrationId: string
): Promise<ToolConfig | null> {
  const s = store();
  const data = await s.get(integrationId, { type: "text" });
  if (!data) return null;
  return JSON.parse(data) as ToolConfig;
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
  return config;
}

export async function deleteToolConfig(integrationId: string): Promise<void> {
  const s = store();
  await s.delete(integrationId);
}
