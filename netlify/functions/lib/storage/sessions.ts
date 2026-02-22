import { getStore } from "@netlify/blobs";
import type { Session } from "../../../../src/lib/types";

const STORE_NAME = "sessions";

function store() {
  return getStore(STORE_NAME);
}

export async function getSession(id: string): Promise<Session | null> {
  const s = store();
  const data = await s.get(id, { type: "text" });
  if (!data) return null;
  return JSON.parse(data) as Session;
}

export async function listSessionsByProject(
  projectId: string
): Promise<Session[]> {
  const s = store();
  const { blobs } = await s.list();
  const sessions: Session[] = [];
  for (const blob of blobs) {
    const data = await s.get(blob.key, { type: "text" });
    if (data) {
      const session = JSON.parse(data) as Session;
      if (session.projectId === projectId) {
        sessions.push(session);
      }
    }
  }
  return sessions.sort(
    (a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

export async function saveSession(session: Session): Promise<Session> {
  const s = store();
  await s.set(session.id, JSON.stringify(session));
  return session;
}

export async function deleteSession(id: string): Promise<void> {
  const s = store();
  await s.delete(id);
}
