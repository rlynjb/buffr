import { db } from "../../db/client";
import { settings } from "../../db/schema";

export async function upsertSetting(key: string, value: unknown): Promise<void> {
  await db.insert(settings).values({
    key,
    value,
  }).onConflictDoUpdate({
    target: settings.key,
    set: { value },
  });
}
