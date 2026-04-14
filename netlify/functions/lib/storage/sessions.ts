import { getStore } from "@netlify/blobs";
import type { Session } from "../../../../src/lib/types";
import { db } from "../db/client";
import { sessions } from "../db/schema";
import { eq, desc } from "drizzle-orm";
import { dbWrite } from "./db/write-guard";
import { upsertSession, deleteSessionDb } from "./db/sessions";

const STORE_NAME = "sessions";

function store() {
  return getStore(STORE_NAME);
}

function rowToSession(row: typeof sessions.$inferSelect): Session {
  return {
    id: row.id,
    projectId: row.projectId,
    goal: row.goal,
    whatChanged: row.whatChanged,
    blockers: row.blockers,
    detectedIntent: row.detectedIntent ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function getSession(id: string): Promise<Session | null> {
  const rows = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
  if (rows.length === 0) return null;
  return rowToSession(rows[0]);
}

export async function listSessionsByProject(
  projectId: string,
): Promise<Session[]> {
  const rows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.projectId, projectId))
    .orderBy(desc(sessions.createdAt));
  return rows.map(rowToSession);
}

export async function saveSession(session: Session): Promise<Session> {
  const s = store();
  await s.set(session.id, JSON.stringify(session));
  await dbWrite("saveSession", () => upsertSession(session));
  return session;
}

export async function deleteSession(id: string): Promise<void> {
  const s = store();
  await s.delete(id);
  await dbWrite("deleteSession", () => deleteSessionDb(id));
}
