import { getStore } from "@netlify/blobs";

const STORE_NAME = "settings";

function store() {
  return getStore(STORE_NAME);
}

export async function getSettings<T = unknown>(key: string): Promise<T | null> {
  const s = store();
  const data = await s.get(key, { type: "text" });
  if (!data) return null;
  return JSON.parse(data) as T;
}

export async function saveSettings<T = unknown>(key: string, value: T): Promise<T> {
  const s = store();
  await s.set(key, JSON.stringify(value));
  return value;
}
