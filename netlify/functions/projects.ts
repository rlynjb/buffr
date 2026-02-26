import type { Context } from "@netlify/functions";
import {
  getProject,
  listProjects,
  saveProject,
  deleteProject,
} from "./lib/storage/projects";
import type { Project } from "../../src/lib/types";
import { randomUUID } from "crypto";
import { json, errorResponse } from "./lib/responses";

export default async function handler(req: Request, _context: Context) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");

  try {
    if (req.method === "GET") {
      if (id) {
        const project = await getProject(id);
        if (!project) {
          return errorResponse("Project not found", 404);
        }
        return json(project);
      }
      const projects = await listProjects();
      return json(projects);
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
        dataSources: body.dataSources || (body.githubRepo ? ["github"] : []),
        dismissedSuggestions: body.dismissedSuggestions || [],
        issueCount: body.issueCount ?? undefined,
        updatedAt: new Date().toISOString(),
      };
      const saved = await saveProject(project);
      return json(saved, 201);
    }

    if (req.method === "PUT") {
      if (!id) {
        return errorResponse("Project id required", 400);
      }
      const existing = await getProject(id);
      if (!existing) {
        return errorResponse("Project not found", 404);
      }
      const body = await req.json();
      const updated = { ...existing, ...body, id: existing.id };
      const saved = await saveProject(updated);
      return json(saved);
    }

    if (req.method === "DELETE") {
      if (!id) {
        return errorResponse("Project id required", 400);
      }
      await deleteProject(id);
      return json({ ok: true });
    }

    return errorResponse("Method not allowed", 405);
  } catch (err) {
    console.error("projects function error:", err);
    return errorResponse("Internal server error", 500);
  }
}
