import type { Context } from "@netlify/functions";
import {
  getActionNotes,
  saveActionNotes,
} from "./lib/storage/action-notes";
import { json, errorResponse } from "./lib/responses";

export default async function handler(req: Request, _context: Context) {
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId");

  if (!projectId) {
    return errorResponse("projectId is required", 400);
  }

  try {
    // GET — return all notes for a project
    if (req.method === "GET") {
      const notes = await getActionNotes(projectId);
      return json(notes);
    }

    // PUT — update a single action's note
    if (req.method === "PUT") {
      const body = await req.json();
      const { actionId, note } = body as { actionId: string; note: string };

      if (!actionId) {
        return errorResponse("actionId is required", 400);
      }

      const notes = await getActionNotes(projectId);
      if (note) {
        notes[actionId] = note;
      } else {
        delete notes[actionId];
      }
      await saveActionNotes(projectId, notes);

      return json(notes);
    }

    return errorResponse("Method not allowed", 405);
  } catch (err) {
    console.error("action-notes function error:", err);
    return errorResponse("Internal server error", 500);
  }
}
