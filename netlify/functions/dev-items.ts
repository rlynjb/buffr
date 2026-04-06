import type { Context } from "@netlify/functions";
import {
  getDevItem,
  listDevItems,
  saveDevItem,
  deleteDevItem,
} from "./lib/storage/dev-items";
import { pushFiles, getRepoInfo } from "./lib/github";
import type { DevItem } from "../../src/lib/types";
import { randomUUID } from "crypto";
import { json, errorResponse } from "./lib/responses";

const ADAPTERS: Record<string, { file: string; rootPath: string }> = {
  "claude-code": { file: "CLAUDE.md", rootPath: "CLAUDE.md" },
  cursor: { file: ".cursorrules", rootPath: ".cursorrules" },
  copilot: { file: "copilot-instructions.md", rootPath: ".github/copilot-instructions.md" },
  windsurf: { file: ".windsurfrules", rootPath: ".windsurfrules" },
  aider: { file: ".aider.conf.yml", rootPath: ".aider.conf.yml" },
  continue: { file: ".continuerules", rootPath: ".continuerules" },
};

function buildAdapterContent(
  adapterId: string,
  items: DevItem[],
): string {
  const sections: string[] = [];

  for (const item of items) {
    sections.push(`## ${item.title}\n`);
    sections.push(item.content.trim());
    sections.push("");
  }

  const body = sections.join("\n").trim();

  switch (adapterId) {
    case "claude-code":
      return `# Project Rules — managed by buffr\n\n${body}`;
    case "cursor":
      return `# Cursor Rules — managed by buffr\n\n${body}`;
    case "copilot":
      return `# GitHub Copilot Instructions — managed by buffr\n\n${body}`;
    case "windsurf":
      return `# Windsurf Rules — managed by buffr\n\n${body}`;
    case "aider":
      return `# Aider Config — managed by buffr\n\nread:\n${items.map((i) => `  - ${i.path}`).join("\n")}`;
    case "continue":
      return `# Continue Rules — managed by buffr\n\n${body}`;
    default:
      return body;
  }
}

export default async function handler(req: Request, _context: Context) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");

  try {
    // GET — list all
    if (req.method === "GET") {
      if (id) {
        const item = await getDevItem(id);
        if (!item) return errorResponse("Item not found", 404);
        return json(item);
      }
      const items = await listDevItems();
      return json(items);
    }

    // POST — create or push
    if (req.method === "POST") {
      const body = await req.json();

      // Push to GitHub
      if (url.searchParams.has("push")) {
        const { repo, adapterIds } = body as {
          repo: string;
          adapterIds?: string[];
        };
        if (!repo?.includes("/")) return errorResponse("repo is required (owner/repo)", 400);

        // Resolve current repo name (handles GitHub renames/redirects)
        const repoInfo = await getRepoInfo(repo);
        if (!repoInfo) return errorResponse(`Repository not found: ${repo}`, 404);
        const [resolvedOwner, resolvedRepo] = repoInfo.fullName.split("/");

        const items = await listDevItems();

        if (items.length === 0) {
          return errorResponse("No .dev items to push", 400);
        }

        // Build dev item files with frontmatter metadata
        const files: Array<{ path: string; content: string; mode?: string }> = items.map((i) => {
          const tags = i.tags || [];
          const fm = [
            "---",
            `title: ${i.title || i.filename}`,
          ];
          if (tags.length > 0) fm.push(`tags: [${tags.join(", ")}]`);
          fm.push("---", "");
          return { path: i.path, content: fm.join("\n") + (i.content || "") };
        });

        // Build adapter files inside .dev/adapters/ with symlinks from root
        const targetAdapters = adapterIds ?? Object.keys(ADAPTERS);
        for (const aid of targetAdapters) {
          const adapter = ADAPTERS[aid];
          if (!adapter) continue;
          const content = buildAdapterContent(aid, items);
          const devPath = `.dev/adapters/${adapter.file}`;
          // Actual content lives in .dev/adapters/
          files.push({ path: devPath, content });
          // Root path is a symlink pointing to .dev/adapters/
          files.push({ path: adapter.rootPath, content: devPath, mode: "120000" });
        }

        try {
          const sha = await pushFiles(
            resolvedOwner,
            resolvedRepo,
            files,
            "chore: update .dev/ rules, skills, and adapters from buffr",
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
      const filename = body.filename || `${body.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`;
      const now = new Date().toISOString();
      const item: DevItem = {
        id: randomUUID(),
        filename,
        path: `.dev/${filename}`,
        title: body.title,
        content: body.content || "",
        communitySource: body.communitySource || null,
        communityVersion: body.communityVersion || null,
        tags: body.tags || [],
        createdAt: now,
        updatedAt: now,
      };
      const saved = await saveDevItem(item);
      return json(saved, 201);
    }

    // PUT — update
    if (req.method === "PUT") {
      if (!id) return errorResponse("id is required", 400);
      const existing = await getDevItem(id);
      if (!existing) return errorResponse("Item not found", 404);
      const body = await req.json();
      const updatedFilename = body.filename ?? existing.filename;
      const updated: DevItem = {
        ...existing,
        title: body.title ?? existing.title,
        content: body.content ?? existing.content,
        filename: updatedFilename,
        tags: body.tags ?? existing.tags,
        path: `.dev/${updatedFilename}`,
        updatedAt: new Date().toISOString(),
      };
      const saved = await saveDevItem(updated);
      return json(saved);
    }

    // DELETE
    if (req.method === "DELETE") {
      if (!id) return errorResponse("id is required", 400);
      await deleteDevItem(id);
      return json({ ok: true });
    }

    return errorResponse("Method not allowed", 405);
  } catch (err) {
    console.error("dev-items function error:", err);
    return errorResponse("Internal server error", 500);
  }
}
