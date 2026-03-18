import type { Context } from "@netlify/functions";
import {
  getProject,
  listProjects,
  saveProject,
  deleteProject,
} from "./lib/storage/projects";
import { saveScanResult } from "./lib/storage/scan-results";
import { detectExistingDevFolder } from "./lib/github";
import type { Project, ScanResult } from "../../src/lib/types";
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
        devFolder: body.devFolder || null,
        updatedAt: new Date().toISOString(),
      };
      // Detect existing .dev/ folder in the repo
      if (project.githubRepo && !project.devFolder) {
        try {
          const devFiles = await detectExistingDevFolder(project.githubRepo);
          if (devFiles && devFiles.length > 0) {
            const now = new Date().toISOString();
            const scanId = randomUUID();
            const scan: ScanResult = {
              id: scanId,
              projectId: project.id,
              repoFullName: project.githubRepo,
              status: "done",
              detectedStack: [],
              detectedPatterns: [],
              techDebtItems: [],
              gapAnalysis: [],
              parsedConfigs: [],
              gitActivity: { recentCommits: 0, activePaths: [], lastCommitDate: "" },
              generatedFiles: devFiles.map((f) => ({
                path: f.path,
                content: f.content,
                ownership: "imported",
              })),
              fileTree: [],
              detectedAdapters: devFiles
                .filter((f) => f.path.startsWith(".dev/adapters/"))
                .map((f) => f.path.replace(".dev/adapters/", "").replace(/\.\w+$/, "")),
              analysisSource: "imported",
              error: null,
              createdAt: now,
              updatedAt: now,
            };
            await saveScanResult(scan);
            project.devFolder = {
              status: "generated",
              lastScan: now,
              scanResultId: scanId,
              gapScore: null,
              adapters: scan.detectedAdapters,
            };
          }
        } catch (err) {
          console.warn("Failed to detect existing .dev/ folder:", err);
          // Non-fatal — project is still created without devFolder
        }
      }

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
      // Whitelist allowed fields to prevent arbitrary field injection
      const allowedFields = [
        "name", "description", "constraints", "goals", "stack", "phase",
        "githubRepo", "repoVisibility", "netlifySiteId", "netlifySiteUrl", "plan",
        "selectedFeatures", "selectedFiles", "dataSources", "dismissedSuggestions",
        "lastSessionId", "issueCount", "devFolder",
      ];
      const updates: Record<string, unknown> = {};
      for (const key of allowedFields) {
        if (key in body) updates[key] = body[key];
      }
      const updated = { ...existing, ...updates };
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
