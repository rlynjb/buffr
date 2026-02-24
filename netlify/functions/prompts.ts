import type { Context } from "@netlify/functions";
import {
  getPrompt,
  listPrompts,
  savePrompt,
  deletePrompt,
} from "./lib/storage/prompts";
import type { Prompt } from "../../src/lib/types";
import { randomUUID } from "crypto";
import { json, errorResponse } from "./lib/responses";

export default async function handler(req: Request, _context: Context) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const scope = url.searchParams.get("scope");

  try {
    if (req.method === "GET") {
      if (id) {
        const prompt = await getPrompt(id);
        if (!prompt) {
          return errorResponse("Prompt not found", 404);
        }
        return json(prompt);
      }
      // List all, optionally filter by scope
      let prompts = await listPrompts();
      if (scope) {
        prompts = prompts.filter(
          (p) => p.scope === "global" || p.scope === scope
        );
      }
      return json(prompts);
    }

    if (req.method === "POST") {
      const body = await req.json();
      const now = new Date().toISOString();
      const prompt: Prompt = {
        id: randomUUID(),
        title: body.title || "",
        body: body.body || "",
        tags: body.tags || [],
        scope: body.scope || "global",
        createdAt: now,
        updatedAt: now,
      };
      const saved = await savePrompt(prompt);
      return json(saved, 201);
    }

    if (req.method === "PUT") {
      if (!id) {
        return errorResponse("Prompt id required", 400);
      }
      const existing = await getPrompt(id);
      if (!existing) {
        return errorResponse("Prompt not found", 404);
      }
      const body = await req.json();
      const updated: Prompt = {
        ...existing,
        title: body.title ?? existing.title,
        body: body.body ?? existing.body,
        tags: body.tags ?? existing.tags,
        scope: body.scope ?? existing.scope,
        updatedAt: new Date().toISOString(),
      };
      const saved = await savePrompt(updated);
      return json(saved);
    }

    if (req.method === "DELETE") {
      if (!id) {
        return errorResponse("Prompt id required", 400);
      }
      await deletePrompt(id);
      return json({ ok: true });
    }

    return errorResponse("Method not allowed", 405);
  } catch (err) {
    console.error("prompts function error:", err);
    return errorResponse("Internal server error", 500);
  }
}
