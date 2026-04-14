import { db } from "../../db/client";
import { manualActions } from "../../db/schema";
import { eq } from "drizzle-orm";
import type { ManualAction } from "../manual-actions";

/**
 * Replaces all manual actions for a project with the given array.
 * Each array element becomes its own row — position derived from index.
 */
export async function syncManualActions(
  projectId: string,
  actions: ManualAction[],
): Promise<void> {
  await db.delete(manualActions).where(eq(manualActions.projectId, projectId));

  if (actions.length === 0) return;

  await db.insert(manualActions).values(
    actions.map((a, i) => ({
      id: a.id,
      projectId,
      text: a.text,
      done: a.done,
      position: i,
    })),
  );
}
