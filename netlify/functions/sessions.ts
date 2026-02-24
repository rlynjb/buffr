import type { Context } from "@netlify/functions";
import {
  getSession,
  listSessionsByProject,
  saveSession,
  deleteSession,
} from "./lib/storage/sessions";
import type { Session } from "../../src/lib/types";
import { randomUUID } from "crypto";
import { json, errorResponse } from "./lib/responses";

export default async function handler(req: Request, _context: Context) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const projectId = url.searchParams.get("projectId");

  try {
    if (req.method === "GET") {
      if (id) {
        const session = await getSession(id);
        if (!session) {
          return errorResponse("Session not found", 404);
        }
        return json(session);
      }
      if (projectId) {
        const sessions = await listSessionsByProject(projectId);
        return json(sessions);
      }
      return errorResponse("Provide id or projectId", 400);
    }

    if (req.method === "POST") {
      const body = await req.json();
      const session: Session = {
        id: randomUUID(),
        projectId: body.projectId,
        goal: body.goal || "",
        whatChanged: body.whatChanged || [],
        nextStep: body.nextStep || "",
        blockers: body.blockers || null,
        createdAt: new Date().toISOString(),
      };
      const saved = await saveSession(session);
      return json(saved, 201);
    }

    if (req.method === "DELETE") {
      if (!id) {
        return errorResponse("Session id required", 400);
      }
      await deleteSession(id);
      return json({ ok: true });
    }

    return errorResponse("Method not allowed", 405);
  } catch (err) {
    console.error("sessions function error:", err);
    return errorResponse("Internal server error", 500);
  }
}
