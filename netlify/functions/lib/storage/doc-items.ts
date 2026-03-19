import { getStore } from "@netlify/blobs";
import type { DocItem } from "../../../../src/lib/types";

const STORE_NAME = "doc-items";

function store() {
  return getStore(STORE_NAME);
}

export async function getDocItem(id: string): Promise<DocItem | null> {
  const s = store();
  const data = await s.get(id, { type: "text" });
  if (!data) return null;
  return JSON.parse(data) as DocItem;
}

export async function listDocItems(): Promise<DocItem[]> {
  const s = store();
  const { blobs } = await s.list();
  const items: DocItem[] = [];
  for (const blob of blobs) {
    const data = await s.get(blob.key, { type: "text" });
    if (data) {
      items.push(JSON.parse(data) as DocItem);
    }
  }
  return items.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

export async function saveDocItem(item: DocItem): Promise<DocItem> {
  const s = store();
  await s.set(item.id, JSON.stringify(item));
  return item;
}

export async function deleteDocItem(id: string): Promise<void> {
  const s = store();
  await s.delete(id);
}
