import { db } from "../../db/client";
import { toolConfigs } from "../../db/schema";
import { eq } from "drizzle-orm";
import type { ToolConfig } from "../../../../../src/lib/types";

export async function upsertToolConfig(config: ToolConfig): Promise<void> {
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
}

export async function deleteToolConfigDb(integrationId: string): Promise<void> {
  await db.delete(toolConfigs).where(eq(toolConfigs.integrationId, integrationId));
}
