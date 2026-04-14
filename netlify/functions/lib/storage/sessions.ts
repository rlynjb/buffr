import type { Session } from "../../../../src/lib/types";
import { db } from "../db/client";
import { sessions } from "../db/schema";
import { eq, desc } from "drizzle-orm";

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
  await db.insert(sessions).values({
    id: session.id,
    projectId: session.projectId,
    goal: session.goal,
    whatChanged: session.whatChanged,
    blockers: session.blockers,
    detectedIntent: session.detectedIntent,
    createdAt: new Date(session.createdAt),
  }).onConflictDoUpdate({
    target: sessions.id,
    set: {
      goal: session.goal,
      whatChanged: session.whatChanged,
      blockers: session.blockers,
      detectedIntent: session.detectedIntent,
    },
  });
  return session;
}

export async function deleteSession(id: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, id));
}
