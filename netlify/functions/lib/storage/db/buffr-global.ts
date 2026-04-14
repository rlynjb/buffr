import { db } from "../../db/client";
import { buffrGlobal } from "../../db/schema";
import { eq } from "drizzle-orm";
import type { BuffrGlobalItem } from "../../../../../src/lib/types";

export async function upsertBuffrGlobalItem(item: BuffrGlobalItem): Promise<void> {
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
}

export async function deleteBuffrGlobalItemDb(id: string): Promise<void> {
  await db.delete(buffrGlobal).where(eq(buffrGlobal.id, id));
}
