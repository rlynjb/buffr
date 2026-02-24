import { getStore } from "@netlify/blobs";
import type { Prompt } from "../../../../src/lib/types";

const STORE_NAME = "prompt-library";

function store() {
  return getStore(STORE_NAME);
}

export async function getPrompt(id: string): Promise<Prompt | null> {
  const s = store();
  const data = await s.get(id, { type: "text" });
  if (!data) return null;
  return JSON.parse(data) as Prompt;
}

export async function listPrompts(): Promise<Prompt[]> {
  const s = store();
  const { blobs } = await s.list();
  const prompts: Prompt[] = [];
  for (const blob of blobs) {
    const data = await s.get(blob.key, { type: "text" });
    if (data) {
      prompts.push(JSON.parse(data) as Prompt);
    }
  }
  return prompts.sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export async function savePrompt(prompt: Prompt): Promise<Prompt> {
  const s = store();
  await s.set(prompt.id, JSON.stringify(prompt));
  return prompt;
}

export async function deletePrompt(id: string): Promise<void> {
  const s = store();
  await s.delete(id);
}
