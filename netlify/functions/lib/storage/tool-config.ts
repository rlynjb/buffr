import { getStore } from "@netlify/blobs";
import type { ToolConfig } from "../../../../src/lib/types";
import { db } from "../db/client";
import { toolConfigs } from "../db/schema";
import { eq } from "drizzle-orm";
import { dbWrite } from "./db/write-guard";
import { upsertToolConfig, deleteToolConfigDb } from "./db/tool-configs";

const STORE_NAME = "tool-config";

function store() {
  return getStore(STORE_NAME);
}

export async function listToolConfigs(): Promise<ToolConfig[]> {
  const rows = await db.select().from(toolConfigs);
  return rows.map((r) => ({
    integrationId: r.integrationId,
    values: r.values as Record<string, string>,
    enabled: r.enabled,
    updatedAt: r.updatedAt.toISOString(),
  }));
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
