import { getStore } from "@netlify/blobs";
import { db } from "../db/client";
import { settings } from "../db/schema";
import { eq } from "drizzle-orm";
import { dbWrite } from "./db/write-guard";
import { upsertSetting } from "./db/settings";

const STORE_NAME = "settings";

function store() {
  return getStore(STORE_NAME);
}

export async function getSettings<T = unknown>(key: string): Promise<T | null> {
  const rows = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  if (rows.length === 0) return null;
  return rows[0].value as T;
}

export async function saveSettings<T = unknown>(key: string, value: T): Promise<T> {
  const s = store();
  await s.set(key, JSON.stringify(value));
  await dbWrite("saveSettings", () => upsertSetting(key, value));
  return value;
}
