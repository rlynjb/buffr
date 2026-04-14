import type { BuffrSpecItem } from "../../../../src/lib/types";
import { db } from "../db/client";
import { buffrSpecs } from "../db/schema";
import { eq, desc } from "drizzle-orm";

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
  await db.insert(buffrSpecs).values({
    id: item.id,
    projectId: item.scope,
    category: item.category,
    filename: item.filename,
    path: item.path,
    title: item.title,
    content: item.content,
    status: item.status,
    createdAt: new Date(item.createdAt),
    updatedAt: new Date(item.updatedAt),
  }).onConflictDoUpdate({
    target: buffrSpecs.id,
    set: {
      projectId: item.scope,
      category: item.category,
      filename: item.filename,
      path: item.path,
      title: item.title,
      content: item.content,
      status: item.status,
      updatedAt: new Date(item.updatedAt),
    },
  });
  return item;
}

export async function deleteBuffrSpecItem(id: string): Promise<void> {
  await db.delete(buffrSpecs).where(eq(buffrSpecs.id, id));
}
