import type { Context } from "@netlify/functions";
import {
  getManualActions,
  saveManualActions,
  type ManualAction,
} from "./lib/storage/manual-actions";
import { json, errorResponse } from "./lib/responses";

export default async function handler(req: Request, _context: Context) {
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId");

  if (!projectId) {
    return errorResponse("projectId is required", 400);
  }

  try {
    // GET — return all manual actions for a project
    if (req.method === "GET") {
      const actions = await getManualActions(projectId);
      return json(actions);
    }

    // POST — add a new manual action
    if (req.method === "POST") {
      const body = await req.json();
      const { id, text } = body as { id: string; text: string };

      if (!id || !text) {
        return errorResponse("id and text are required", 400);
      }

      const actions = await getManualActions(projectId);
      actions.push({ id, text, done: false });
      await saveManualActions(projectId, actions);
      return json(actions, 201);
    }

    // PUT — toggle done or update text
    if (req.method === "PUT") {
      const body = await req.json();
      const { id, done, text } = body as { id: string; done?: boolean; text?: string };

      if (!id) {
        return errorResponse("id is required", 400);
      }

      const actions = await getManualActions(projectId);
      const action = actions.find((a) => a.id === id);
      if (!action) {
        return errorResponse("Action not found", 404);
      }

      if (typeof done === "boolean") action.done = done;
      if (typeof text === "string") action.text = text;

      await saveManualActions(projectId, actions);
      return json(actions);
    }

    // DELETE — remove a manual action
    if (req.method === "DELETE") {
      const actionId = url.searchParams.get("actionId");
      if (!actionId) {
        return errorResponse("actionId is required", 400);
      }

      const actions = await getManualActions(projectId);
      const filtered = actions.filter((a) => a.id !== actionId);
      await saveManualActions(projectId, filtered);
      return json(filtered);
    }

    return errorResponse("Method not allowed", 405);
  } catch (err) {
    console.error("manual-actions function error:", err);
    return errorResponse("Internal server error", 500);
  }
}
