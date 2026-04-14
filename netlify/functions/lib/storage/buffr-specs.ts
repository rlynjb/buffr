import { getStore } from "@netlify/blobs";
import type { BuffrSpecItem } from "../../../../src/lib/types";
import { db } from "../db/client";
import { buffrSpecs } from "../db/schema";
import { eq, desc } from "drizzle-orm";
import { dbWrite } from "./db/write-guard";
import { upsertBuffrSpecItem, deleteBuffrSpecItemDb } from "./db/buffr-specs";

const STORE_NAME = "buffr-specs";

function store() {
  return getStore(STORE_NAME);
}

function rowToItem(row: typeof buffrSpecs.$inferSelect): BuffrSpecItem {
  return {
    id: row.id,
    category: row.category as BuffrSpecItem["category"],
    filename: row.filename,
    path: row.path,
    title: row.title,
    content: row.content,
    scope: row.projectId,
    status: row.status as BuffrSpecItem["status"],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getBuffrSpecItem(id: string): Promise<BuffrSpecItem | null> {
  const rows = await db.select().from(buffrSpecs).where(eq(buffrSpecs.id, id)).limit(1);
  if (rows.length === 0) return null;
  return rowToItem(rows[0]);
}

export async function listBuffrSpecItems(): Promise<BuffrSpecItem[]> {
  const rows = await db.select().from(buffrSpecs).orderBy(desc(buffrSpecs.updatedAt));
  return rows.map(rowToItem);
}

export async function saveBuffrSpecItem(item: BuffrSpecItem): Promise<BuffrSpecItem> {
  const s = store();
  await s.set(item.id, JSON.stringify(item));
  await dbWrite("saveBuffrSpecItem", () => upsertBuffrSpecItem(item));
  return item;
}

export async function deleteBuffrSpecItem(id: string): Promise<void> {
  const s = store();
  await s.delete(id);
  await dbWrite("deleteBuffrSpecItem", () => deleteBuffrSpecItemDb(id));
}
