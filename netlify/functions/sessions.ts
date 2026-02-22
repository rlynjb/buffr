import type { Context } from "@netlify/functions";
import {
  getSession,
  listSessionsByProject,
  saveSession,
  deleteSession,
} from "./lib/storage/sessions";
import type { Session } from "../../src/lib/types";
import { randomUUID } from "crypto";

export default async function handler(req: Request, _context: Context) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const projectId = url.searchParams.get("projectId");

  try {
    if (req.method === "GET") {
      if (id) {
        const session = await getSession(id);
        if (!session) {
          return new Response(JSON.stringify({ error: "Session not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify(session), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (projectId) {
        const sessions = await listSessionsByProject(projectId);
        return new Response(JSON.stringify(sessions), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ error: "Provide id or projectId" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
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
        gitSnapshot: body.gitSnapshot || null,
        createdAt: new Date().toISOString(),
      };
      const saved = await saveSession(session);
      return new Response(JSON.stringify(saved), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (req.method === "DELETE") {
      if (!id) {
        return new Response(
          JSON.stringify({ error: "Session id required" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      await deleteSession(id);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("sessions function error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
