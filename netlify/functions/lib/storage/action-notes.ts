import { getStore } from "@netlify/blobs";

const STORE_NAME = "action-notes";

function store() {
  return getStore(STORE_NAME);
}

/** Notes are stored per project as a JSON object: { [actionId]: noteText } */
export type ActionNotes = Record<string, string>;

export async function getActionNotes(projectId: string): Promise<ActionNotes> {
  const s = store();
  const data = await s.get(projectId, { type: "text" });
  if (!data) return {};
  return JSON.parse(data) as ActionNotes;
}

export async function saveActionNotes(
  projectId: string,
  notes: ActionNotes
): Promise<ActionNotes> {
  const s = store();
  await s.set(projectId, JSON.stringify(notes));
  return notes;
}
