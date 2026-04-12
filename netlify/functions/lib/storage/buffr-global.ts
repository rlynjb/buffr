import { getStore } from "@netlify/blobs";
import type { BuffrGlobalItem } from "../../../../src/lib/types";

const STORE_NAME = "buffr-global";

function store() {
  return getStore(STORE_NAME);
}

export async function getBuffrGlobalItem(id: string): Promise<BuffrGlobalItem | null> {
  const s = store();
  const data = await s.get(id, { type: "text" });
  if (!data) return null;
  return JSON.parse(data) as BuffrGlobalItem;
}

export async function listBuffrGlobalItems(): Promise<BuffrGlobalItem[]> {
  const s = store();
  const { blobs } = await s.list();
  const items: BuffrGlobalItem[] = [];
  for (const blob of blobs) {
    const data = await s.get(blob.key, { type: "text" });
    if (data) {
      items.push(JSON.parse(data) as BuffrGlobalItem);
    }
  }
  return items.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

export async function saveBuffrGlobalItem(item: BuffrGlobalItem): Promise<BuffrGlobalItem> {
  const s = store();
  await s.set(item.id, JSON.stringify(item));
  return item;
}

export async function deleteBuffrGlobalItem(id: string): Promise<void> {
  const s = store();
  await s.delete(id);
}
