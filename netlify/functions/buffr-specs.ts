import type { Context } from "@netlify/functions";
import {
  getBuffrSpecItem,
  listBuffrSpecItems,
  saveBuffrSpecItem,
  deleteBuffrSpecItem,
} from "./lib/storage/buffr-specs";
import { pushFiles, getRepoInfo } from "./lib/github";
import type { BuffrSpecItem, BuffrSpecCategory } from "../../src/lib/types";
import { randomUUID } from "crypto";
import { json, errorResponse } from "./lib/responses";

export default async function handler(req: Request, _context: Context) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const scope = url.searchParams.get("scope");

  try {
    // GET — list or get single
    if (req.method === "GET") {
      if (id) {
        const item = await getBuffrSpecItem(id);
        if (!item) return errorResponse("Item not found", 404);
        return json(item);
      }
      let items = await listBuffrSpecItems();
      if (scope) {
        items = items.filter((i) => i.scope === scope);
      }
      return json(items);
    }

    // POST — create or push
    if (req.method === "POST") {
      const body = await req.json();

      // Push to GitHub
      if (url.searchParams.has("push")) {
        const { projectId, repo } = body as {
          projectId: string;
          repo: string;
        };
        if (!repo?.includes("/")) return errorResponse("repo is required (owner/repo)", 400);

        const repoInfo = await getRepoInfo(repo);
        if (!repoInfo) return errorResponse(`Repository not found: ${repo}`, 404);
        const [resolvedOwner, resolvedRepo] = repoInfo.fullName.split("/");

        let items = await listBuffrSpecItems();
        items = items.filter((i) => i.scope === projectId);

        if (items.length === 0) {
          return errorResponse("No .buffr/specs items to push", 400);
        }

        const files: Array<{ path: string; content: string }> = items.map((i) => {
          const fm = [
            "---",
            `title: ${i.title || i.filename}`,
            `category: ${i.category}`,
            "---",
            "",
          ];
          return { path: i.path, content: fm.join("\n") + (i.content || "") };
        });

        try {
          const sha = await pushFiles(
            resolvedOwner,
            resolvedRepo,
            files,
            "docs: update .buffr/specs/ from buffr",
            undefined,
            repoInfo.defaultBranch,
          );
          return json({ sha });
        } catch (pushErr) {
          const msg = pushErr instanceof Error ? pushErr.message : "Push failed";
          console.error("GitHub push error:", msg);
          return errorResponse(`GitHub push failed: ${msg}`, 502);
        }
      }

      // Create item
      if (!body.title?.trim()) return errorResponse("title is required", 400);
      const category: BuffrSpecCategory = body.category || "features";
      const filename = body.filename || `${body.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`;
      const now = new Date().toISOString();
      const item: BuffrSpecItem = {
        id: randomUUID(),
        category,
        filename,
        path: `.buffr/specs/${category}/${filename}`,
        title: body.title,
        content: body.content || "",
        status: body.status || "draft",
        scope: body.scope || "",
        createdAt: now,
        updatedAt: now,
      };
      const saved = await saveBuffrSpecItem(item);
      return json(saved, 201);
    }

    // PUT — update
    if (req.method === "PUT") {
      if (!id) return errorResponse("id is required", 400);
      const existing = await getBuffrSpecItem(id);
      if (!existing) return errorResponse("Item not found", 404);
      const body = await req.json();
      const updated: BuffrSpecItem = {
        ...existing,
        title: body.title ?? existing.title,
        content: body.content ?? existing.content,
        category: body.category ?? existing.category,
        filename: body.filename ?? existing.filename,
        scope: body.scope ?? existing.scope,
        status: body.status ?? existing.status,
        path: body.category
          ? `.buffr/specs/${body.category}/${body.filename ?? existing.filename}`
          : body.filename
            ? `.buffr/specs/${existing.category}/${body.filename}`
            : existing.path,
        updatedAt: new Date().toISOString(),
      };
      const saved = await saveBuffrSpecItem(updated);
      return json(saved);
    }

    // DELETE
    if (req.method === "DELETE") {
      if (!id) return errorResponse("id is required", 400);
      await deleteBuffrSpecItem(id);
      return json({ ok: true });
    }

    return errorResponse("Method not allowed", 405);
  } catch (err) {
    console.error("buffr-specs function error:", err);
    return errorResponse("Internal server error", 500);
  }
}
