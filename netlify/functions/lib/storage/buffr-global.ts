import { getStore } from "@netlify/blobs";
import type { BuffrGlobalItem } from "../../../../src/lib/types";
import { db } from "../db/client";
import { buffrGlobal } from "../db/schema";
import { eq, desc } from "drizzle-orm";
import { dbWrite } from "./db/write-guard";
import { upsertBuffrGlobalItem, deleteBuffrGlobalItemDb } from "./db/buffr-global";

const STORE_NAME = "buffr-global";

function store() {
  return getStore(STORE_NAME);
}

function rowToItem(row: typeof buffrGlobal.$inferSelect): BuffrGlobalItem {
  return {
    id: row.id,
    filename: row.filename,
    path: row.path,
    category: row.category as BuffrGlobalItem["category"],
    title: row.title,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getBuffrGlobalItem(id: string): Promise<BuffrGlobalItem | null> {
  const rows = await db.select().from(buffrGlobal).where(eq(buffrGlobal.id, id)).limit(1);
  if (rows.length === 0) return null;
  return rowToItem(rows[0]);
}

export async function listBuffrGlobalItems(): Promise<BuffrGlobalItem[]> {
  const rows = await db.select().from(buffrGlobal).orderBy(desc(buffrGlobal.updatedAt));
  return rows.map(rowToItem);
}

export async function saveBuffrGlobalItem(item: BuffrGlobalItem): Promise<BuffrGlobalItem> {
  const s = store();
  await s.set(item.id, JSON.stringify(item));
  await dbWrite("saveBuffrGlobalItem", () => upsertBuffrGlobalItem(item));
  return item;
}

export async function deleteBuffrGlobalItem(id: string): Promise<void> {
  const s = store();
  await s.delete(id);
  await dbWrite("deleteBuffrGlobalItem", () => deleteBuffrGlobalItemDb(id));
}
