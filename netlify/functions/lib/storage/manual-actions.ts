import { db } from "../db/client";
import { manualActions } from "../db/schema";
import { eq, asc } from "drizzle-orm";

export interface ManualAction {
  id: string;
  text: string;
  done: boolean;
  specPath?: string | null;
}

export async function getManualActions(projectId: string): Promise<ManualAction[]> {
  const rows = await db
    .select()
    .from(manualActions)
    .where(eq(manualActions.projectId, projectId))
    .orderBy(asc(manualActions.position));
  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    done: r.done,
    specPath: r.specPath,
  }));
}

export async function saveManualActions(
  projectId: string,
  actions: ManualAction[],
): Promise<ManualAction[]> {
  await db.delete(manualActions).where(eq(manualActions.projectId, projectId));
  if (actions.length > 0) {
    await db.insert(manualActions).values(
      actions.map((a, i) => ({
        id: a.id,
        projectId,
        text: a.text,
        done: a.done,
        position: i,
        specPath: a.specPath ?? null,
      })),
    );
  }
  return actions;
}

export async function updateManualActionSpecPath(
  projectId: string,
  actionId: string,
  specPath: string,
): Promise<void> {
  await db.update(manualActions)
    .set({ specPath })
    .where(eq(manualActions.id, actionId));
}
