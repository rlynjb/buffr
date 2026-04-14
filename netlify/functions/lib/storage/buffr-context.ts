import type { BuffrContextItem } from "../../../../src/lib/types";
import { db } from "../db/client";
import { buffrContext } from "../db/schema";
import { eq, desc } from "drizzle-orm";

function rowToItem(row: typeof buffrContext.$inferSelect): BuffrContextItem {
  return {
    id: row.id,
    projectId: row.projectId,
    filename: row.filename,
    path: row.path,
    category: row.category as BuffrContextItem["category"],
    title: row.title,
    content: row.content,
    generatedAt: row.generatedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getBuffrContextItem(id: string): Promise<BuffrContextItem | null> {
  const rows = await db.select().from(buffrContext).where(eq(buffrContext.id, id)).limit(1);
  if (rows.length === 0) return null;
  return rowToItem(rows[0]);
}

export async function listBuffrContextItems(projectId: string): Promise<BuffrContextItem[]> {
  const rows = await db
    .select()
    .from(buffrContext)
    .where(eq(buffrContext.projectId, projectId))
    .orderBy(desc(buffrContext.updatedAt));
  return rows.map(rowToItem);
}

export async function saveBuffrContextItem(item: BuffrContextItem): Promise<BuffrContextItem> {
  await db.insert(buffrContext).values({
    id: item.id,
    projectId: item.projectId,
    filename: item.filename,
    path: item.path,
    category: item.category,
    title: item.title,
    content: item.content,
    generatedAt: new Date(item.generatedAt),
    updatedAt: new Date(item.updatedAt),
  }).onConflictDoUpdate({
    target: buffrContext.id,
    set: {
      filename: item.filename,
      path: item.path,
      category: item.category,
      title: item.title,
      content: item.content,
      generatedAt: new Date(item.generatedAt),
      updatedAt: new Date(item.updatedAt),
    },
  });
  return item;
}

export async function deleteBuffrContextItem(id: string): Promise<void> {
  await db.delete(buffrContext).where(eq(buffrContext.id, id));
}
