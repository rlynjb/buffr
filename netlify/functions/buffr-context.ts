import type { Context } from "@netlify/functions";
import {
  getBuffrContextItem,
  listBuffrContextItems,
  saveBuffrContextItem,
  deleteBuffrContextItem,
} from "./lib/storage/buffr-context";
import { getProject } from "./lib/storage/projects";
import { listSessionsByProject } from "./lib/storage/sessions";
import { pushFiles, getRepoInfo } from "./lib/github";
import { getLLM } from "./lib/ai/provider";
import { createContextChain } from "./lib/ai/chains/context-generator";
import type { BuffrContextItem } from "../../src/lib/types";
import { randomUUID } from "crypto";
import { json, errorResponse, classifyError } from "./lib/responses";

export default async function handler(req: Request, _context: Context) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const projectId = url.searchParams.get("projectId");

  try {
    // GET — list by project or get single
    if (req.method === "GET") {
      if (id) {
        const item = await getBuffrContextItem(id);
        if (!item) return errorResponse("Item not found", 404);
        return json(item);
      }
      if (!projectId) return errorResponse("projectId is required", 400);
      const items = await listBuffrContextItems(projectId);
      return json(items);
    }

    // POST — generate or push
    if (req.method === "POST") {
      const body = await req.json();

      // Generate context via AI
      if (url.searchParams.has("generate")) {
        const pid = body.projectId;
        if (!pid) return errorResponse("projectId is required", 400);

        const project = await getProject(pid);
        if (!project) return errorResponse("Project not found", 404);

        const sessions = await listSessionsByProject(pid);
        const provider = (body.provider as string) || "anthropic";

        // Optional repo analysis
        let repoAnalysis: string | undefined;
        if (project.githubRepo) {
          try {
            const { executeTool } = await import("./lib/tools/registry");
            const result = await executeTool("github_analyze_repo", {
              owner: project.githubRepo.split("/")[0],
              repo: project.githubRepo.split("/")[1],
            });
            if (result.ok && result.result) {
              repoAnalysis = JSON.stringify(result.result, null, 2);
            }
          } catch {
            // Repo analysis is optional
          }
        }

        const llm = getLLM(provider);
        const chain = createContextChain(llm);
        const result = await chain.invoke({
          projectName: project.name,
          projectDescription: project.description,
          projectStack: project.stack,
          projectPhase: project.phase,
          recentSessions: sessions.slice(0, 10).map((s) => ({
            goal: s.goal,
            whatChanged: s.whatChanged,
            detectedIntent: s.detectedIntent,
            createdAt: s.createdAt,
          })),
          repoAnalysis,
        });

        const now = new Date().toISOString();
        const item: BuffrContextItem = {
          id: randomUUID(),
          projectId: pid,
          filename: "context.md",
          path: ".buffr/project/context.md",
          category: "context",
          title: result.title,
          content: result.content,
          generatedAt: now,
          updatedAt: now,
        };

        // Check if a context.md already exists — update it instead
        const existing = await listBuffrContextItems(pid);
        const prev = existing.find((e) => e.filename === "context.md");
        if (prev) {
          item.id = prev.id;
        }

        const saved = await saveBuffrContextItem(item);
        return json(saved, 201);
      }

      // Push to GitHub
      if (url.searchParams.has("push")) {
        const { projectId: pid, repo } = body as { projectId: string; repo: string };
        if (!repo?.includes("/")) return errorResponse("repo is required (owner/repo)", 400);

        const repoInfo = await getRepoInfo(repo);
        if (!repoInfo) return errorResponse(`Repository not found: ${repo}`, 404);
        const [resolvedOwner, resolvedRepo] = repoInfo.fullName.split("/");

        const items = await listBuffrContextItems(pid);
        if (items.length === 0) return errorResponse("No context files to push", 400);

        const files = items.map((i) => ({
          path: i.path,
          content: `---\ntitle: ${i.title}\ncategory: ${i.category}\n---\n\n${i.content}`,
        }));

        try {
          const sha = await pushFiles(
            resolvedOwner,
            resolvedRepo,
            files,
            "chore: update .buffr/project/ context from buffr",
            undefined,
            repoInfo.defaultBranch,
          );
          return json({ sha });
        } catch (pushErr) {
          const msg = pushErr instanceof Error ? pushErr.message : "Push failed";
          return errorResponse(`GitHub push failed: ${msg}`, 502);
        }
      }

      return errorResponse("Use ?generate or ?push", 400);
    }

    // PUT — manual edit
    if (req.method === "PUT") {
      if (!id) return errorResponse("id is required", 400);
      const existing = await getBuffrContextItem(id);
      if (!existing) return errorResponse("Item not found", 404);
      const body = await req.json();
      const updated: BuffrContextItem = {
        ...existing,
        content: body.content ?? existing.content,
        title: body.title ?? existing.title,
        updatedAt: new Date().toISOString(),
      };
      const saved = await saveBuffrContextItem(updated);
      return json(saved);
    }

    // DELETE
    if (req.method === "DELETE") {
      if (!id) return errorResponse("id is required", 400);
      await deleteBuffrContextItem(id);
      return json({ ok: true });
    }

    return errorResponse("Method not allowed", 405);
  } catch (err) {
    console.error("buffr-context function error:", err);
    const { message, status } = classifyError(err, "Internal server error");
    return errorResponse(message, status);
  }
}
