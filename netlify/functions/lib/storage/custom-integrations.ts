import { getStore } from "@netlify/blobs";
import type { CustomIntegration } from "../../../../src/lib/types";

const STORE_NAME = "custom-integrations";

function store() {
  return getStore(STORE_NAME);
}

export async function listCustomIntegrations(): Promise<CustomIntegration[]> {
  const s = store();
  const { blobs } = await s.list();
  const items: CustomIntegration[] = [];
  for (const blob of blobs) {
    const data = await s.get(blob.key, { type: "text" });
    if (data) {
      items.push(JSON.parse(data) as CustomIntegration);
    }
  }
  return items.sort(
    (a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

export async function saveCustomIntegration(
  integration: CustomIntegration
): Promise<CustomIntegration> {
  const s = store();
  await s.set(integration.id, JSON.stringify(integration));
  return integration;
}

export async function deleteCustomIntegration(id: string): Promise<void> {
  const s = store();
  await s.delete(id);
}
