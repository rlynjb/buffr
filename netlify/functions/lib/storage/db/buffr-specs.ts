import { db } from "../../db/client";
import { buffrSpecs } from "../../db/schema";
import { eq } from "drizzle-orm";
import type { BuffrSpecItem } from "../../../../../src/lib/types";

export async function upsertBuffrSpecItem(item: BuffrSpecItem): Promise<void> {
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
}

export async function deleteBuffrSpecItemDb(id: string): Promise<void> {
  await db.delete(buffrSpecs).where(eq(buffrSpecs.id, id));
}
