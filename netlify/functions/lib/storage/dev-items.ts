import { getStore } from "@netlify/blobs";
import type { DevItem } from "../../../../src/lib/types";

const STORE_NAME = "dev-items";

function store() {
  return getStore(STORE_NAME);
}

export async function getDevItem(id: string): Promise<DevItem | null> {
  const s = store();
  const data = await s.get(id, { type: "text" });
  if (!data) return null;
  return JSON.parse(data) as DevItem;
}

export async function listDevItems(): Promise<DevItem[]> {
  const s = store();
  const { blobs } = await s.list();
  const items: DevItem[] = [];
  for (const blob of blobs) {
    const data = await s.get(blob.key, { type: "text" });
    if (data) {
      items.push(JSON.parse(data) as DevItem);
    }
  }
  return items.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

export async function saveDevItem(item: DevItem): Promise<DevItem> {
  const s = store();
  await s.set(item.id, JSON.stringify(item));
  return item;
}

export async function deleteDevItem(id: string): Promise<void> {
  const s = store();
  await s.delete(id);
}
