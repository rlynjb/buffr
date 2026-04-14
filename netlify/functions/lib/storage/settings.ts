import { db } from "../db/client";
import { settings } from "../db/schema";
import { eq } from "drizzle-orm";

export async function getSettings<T = unknown>(key: string): Promise<T | null> {
  const rows = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  if (rows.length === 0) return null;
  return rows[0].value as T;
}

export async function saveSettings<T = unknown>(key: string, value: T): Promise<T> {
  await db.insert(settings).values({
    key,
    value,
  }).onConflictDoUpdate({
    target: settings.key,
    set: { value },
  });
  return value;
}
