import type { Context } from "@netlify/functions";
import {
  getProject,
  listProjects,
  saveProject,
  deleteProject,
} from "./lib/storage/projects";
import type { Project } from "../../src/lib/types";
import { randomUUID } from "crypto";

export default async function handler(req: Request, _context: Context) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");

  try {
    if (req.method === "GET") {
      if (id) {
        const project = await getProject(id);
        if (!project) {
          return new Response(JSON.stringify({ error: "Project not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify(project), {
          headers: { "Content-Type": "application/json" },
        });
      }
      const projects = await listProjects();
      return new Response(JSON.stringify(projects), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (req.method === "POST") {
      const body = await req.json();
      const project: Project = {
        id: randomUUID(),
        name: body.name || "Untitled",
        description: body.description || "",
        constraints: body.constraints || "",
        goals: body.goals || "",
        stack: body.stack || "",
        phase: body.phase || "idea",
        lastSessionId: null,
        githubRepo: body.githubRepo || null,
        repoVisibility: body.repoVisibility || "private",
        netlifySiteId: body.netlifySiteId || null,
        netlifySiteUrl: body.netlifySiteUrl || null,
        plan: body.plan || null,
        selectedFeatures: body.selectedFeatures || null,
        selectedFiles: body.selectedFiles || null,
        issueCount: body.issueCount ?? undefined,
        updatedAt: new Date().toISOString(),
      };
      const saved = await saveProject(project);
      return new Response(JSON.stringify(saved), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (req.method === "PUT") {
      if (!id) {
        return new Response(
          JSON.stringify({ error: "Project id required" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      const existing = await getProject(id);
      if (!existing) {
        return new Response(JSON.stringify({ error: "Project not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      const body = await req.json();
      const updated = { ...existing, ...body, id: existing.id };
      const saved = await saveProject(updated);
      return new Response(JSON.stringify(saved), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (req.method === "DELETE") {
      if (!id) {
        return new Response(
          JSON.stringify({ error: "Project id required" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      await deleteProject(id);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("projects function error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
