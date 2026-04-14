import { getStore } from "@netlify/blobs";
import { db } from "../db/client";
import { manualActions } from "../db/schema";
import { eq, asc } from "drizzle-orm";
import { dbWrite } from "./db/write-guard";
import { syncManualActions } from "./db/manual-actions";

const STORE_NAME = "manual-actions";

function store() {
  return getStore(STORE_NAME);
}

export interface ManualAction {
  id: string;
  text: string;
  done: boolean;
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
  }));
}

export async function saveManualActions(
  projectId: string,
  actions: ManualAction[],
): Promise<ManualAction[]> {
  const s = store();
  await s.set(projectId, JSON.stringify(actions));
  await dbWrite("saveManualActions", () => syncManualActions(projectId, actions));
  return actions;
}
