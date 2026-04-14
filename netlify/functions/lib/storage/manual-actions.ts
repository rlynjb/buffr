import { getStore } from "@netlify/blobs";
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
  const s = store();
  const data = await s.get(projectId, { type: "text" });
  if (!data) return [];
  return JSON.parse(data) as ManualAction[];
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
