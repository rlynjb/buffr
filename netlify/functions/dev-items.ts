import type { Context } from "@netlify/functions";
import {
  getDevItem,
  listDevItems,
  saveDevItem,
  deleteDevItem,
} from "./lib/storage/dev-items";
import { pushFiles, getRepoInfo } from "./lib/github";
import type { DevItem, DevItemCategory } from "../../src/lib/types";
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
  const rules = items.filter((i) => i.category === "ai-rules");
  const skills = items.filter((i) => i.category === "skills");
  const community = items.filter((i) => i.category === "community-skills");

  const sections: string[] = [];

  if (rules.length > 0) {
    sections.push("## AI Rules\n");
    for (const r of rules) {
      sections.push(r.content.trim());
      sections.push("");
    }
  }

  if (skills.length > 0) {
    sections.push("## Skills\n");
    for (const s of skills) {
      sections.push(`### ${s.title}\n`);
      sections.push(s.content.trim());
      sections.push("");
    }
  }

  if (community.length > 0) {
    sections.push("## Community Skills\n");
    for (const c of community) {
      sections.push(`### ${c.title}\n`);
      sections.push(c.content.trim());
      sections.push("");
    }
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
  const scope = url.searchParams.get("scope");

  try {
    // GET — list or get single
    if (req.method === "GET") {
      if (id) {
        const item = await getDevItem(id);
        if (!item) return errorResponse("Item not found", 404);
        return json(item);
      }
      let items = await listDevItems();
      if (scope) {
        items = items.filter((i) => i.scope === "global" || i.scope === scope);
      }
      return json(items);
    }

    // POST — create or push
    if (req.method === "POST") {
      const body = await req.json();

      // Push to GitHub
      if (url.searchParams.has("push")) {
        const { projectId, repo, adapterIds } = body as {
          projectId: string;
          repo: string;
          adapterIds?: string[];
        };
        if (!repo?.includes("/")) return errorResponse("repo is required (owner/repo)", 400);

        // Resolve current repo name (handles GitHub renames/redirects)
        const repoInfo = await getRepoInfo(repo);
        if (!repoInfo) return errorResponse(`Repository not found: ${repo}`, 404);
        const [resolvedOwner, resolvedRepo] = repoInfo.fullName.split("/");

        let items = await listDevItems();
        items = items.filter((i) => i.scope === "global" || i.scope === projectId);

        // Build dev item files with frontmatter metadata
        const files: Array<{ path: string; content: string }> = items.map((i) => {
          const tags = i.tags || [];
          const fm = [
            "---",
            `title: ${i.title || i.filename}`,
            `category: ${i.category}`,
            `scope: ${i.scope === "global" ? "global" : "project"}`,
          ];
          if (tags.length > 0) fm.push(`tags: [${tags.join(", ")}]`);
          fm.push("---", "");
          return { path: i.path, content: fm.join("\n") + (i.content || "") };
        });

        // Build adapter files
        const targetAdapters = adapterIds || Object.keys(ADAPTERS);
        for (const aid of targetAdapters) {
          const adapter = ADAPTERS[aid];
          if (!adapter) continue;
          const content = buildAdapterContent(aid, items);
          files.push({ path: adapter.rootPath, content });
        }

        const sha = await pushFiles(
          resolvedOwner,
          resolvedRepo,
          files,
          "chore: update .dev/ rules, skills, and adapters from buffr",
          undefined,
          repoInfo.defaultBranch,
        );
        return json({ sha });
      }

      // Create item
      if (!body.title?.trim()) return errorResponse("title is required", 400);
      const category: DevItemCategory = body.category || "ai-rules";
      const filename = body.filename || `${body.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`;
      const now = new Date().toISOString();
      const item: DevItem = {
        id: randomUUID(),
        category,
        filename,
        path: `.dev/${category}/${filename}`,
        title: body.title,
        content: body.content || "",
        scope: body.scope || "global",
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
      const updated: DevItem = {
        ...existing,
        title: body.title ?? existing.title,
        content: body.content ?? existing.content,
        category: body.category ?? existing.category,
        filename: body.filename ?? existing.filename,
        tags: body.tags ?? existing.tags,
        scope: body.scope ?? existing.scope,
        path: body.category
          ? `.dev/${body.category}/${body.filename ?? existing.filename}`
          : body.filename
            ? `.dev/${existing.category}/${body.filename}`
            : existing.path,
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
