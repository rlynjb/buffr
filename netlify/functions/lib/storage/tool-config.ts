import type { ToolConfig } from "../../../../src/lib/types";
import { db } from "../db/client";
import { toolConfigs } from "../db/schema";
import { eq } from "drizzle-orm";

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
  config.updatedAt = new Date().toISOString();
  await db.insert(toolConfigs).values({
    integrationId: config.integrationId,
    values: config.values,
    enabled: config.enabled,
    updatedAt: new Date(config.updatedAt),
  }).onConflictDoUpdate({
    target: toolConfigs.integrationId,
    set: {
      values: config.values,
      enabled: config.enabled,
      updatedAt: new Date(config.updatedAt),
    },
  });
  return config;
}

export async function deleteToolConfig(integrationId: string): Promise<void> {
  await db.delete(toolConfigs).where(eq(toolConfigs.integrationId, integrationId));
}
