import { db } from "../../db/client";
import { sessions } from "../../db/schema";
import { eq } from "drizzle-orm";
import type { Session } from "../../../../../src/lib/types";

export async function upsertSession(session: Session): Promise<void> {
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
}

export async function deleteSessionDb(id: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, id));
}
