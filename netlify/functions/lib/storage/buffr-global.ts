import type { BuffrGlobalItem } from "../../../../src/lib/types";
import { db } from "../db/client";
import { buffrGlobal } from "../db/schema";
import { eq, desc } from "drizzle-orm";

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
  await db.insert(buffrGlobal).values({
    id: item.id,
    filename: item.filename,
    path: item.path,
    category: item.category,
    title: item.title,
    content: item.content,
    createdAt: new Date(item.createdAt),
    updatedAt: new Date(item.updatedAt),
  }).onConflictDoUpdate({
    target: buffrGlobal.id,
    set: {
      filename: item.filename,
      path: item.path,
      category: item.category,
      title: item.title,
      content: item.content,
      updatedAt: new Date(item.updatedAt),
    },
  });
  return item;
}

export async function deleteBuffrGlobalItem(id: string): Promise<void> {
  await db.delete(buffrGlobal).where(eq(buffrGlobal.id, id));
}
