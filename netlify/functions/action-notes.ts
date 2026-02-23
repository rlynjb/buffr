import type { Context } from "@netlify/functions";
import {
  getActionNotes,
  saveActionNotes,
} from "./lib/storage/action-notes";

export default async function handler(req: Request, _context: Context) {
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId");

  if (!projectId) {
    return new Response(
      JSON.stringify({ error: "projectId is required" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    // GET — return all notes for a project
    if (req.method === "GET") {
      const notes = await getActionNotes(projectId);
      return new Response(JSON.stringify(notes), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // PUT — update a single action's note
    if (req.method === "PUT") {
      const body = await req.json();
      const { actionId, note } = body as { actionId: string; note: string };

      if (!actionId) {
        return new Response(
          JSON.stringify({ error: "actionId is required" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      const notes = await getActionNotes(projectId);
      if (note) {
        notes[actionId] = note;
      } else {
        delete notes[actionId];
      }
      await saveActionNotes(projectId, notes);

      return new Response(JSON.stringify(notes), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("action-notes function error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
