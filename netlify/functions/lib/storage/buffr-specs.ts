import { getStore } from "@netlify/blobs";
import type { BuffrSpecItem } from "../../../../src/lib/types";

const STORE_NAME = "buffr-specs";

function store() {
  return getStore(STORE_NAME);
}

export async function getBuffrSpecItem(id: string): Promise<BuffrSpecItem | null> {
  const s = store();
  const data = await s.get(id, { type: "text" });
  if (!data) return null;
  return JSON.parse(data) as BuffrSpecItem;
}

export async function listBuffrSpecItems(): Promise<BuffrSpecItem[]> {
  const s = store();
  const { blobs } = await s.list();
  const items: BuffrSpecItem[] = [];
  for (const blob of blobs) {
    const data = await s.get(blob.key, { type: "text" });
    if (data) {
      items.push(JSON.parse(data) as BuffrSpecItem);
    }
  }
  return items.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

export async function saveBuffrSpecItem(item: BuffrSpecItem): Promise<BuffrSpecItem> {
  const s = store();
  await s.set(item.id, JSON.stringify(item));
  return item;
}

export async function deleteBuffrSpecItem(id: string): Promise<void> {
  const s = store();
  await s.delete(id);
}
