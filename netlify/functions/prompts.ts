import type { Context } from "@netlify/functions";
import {
  getPrompt,
  listPrompts,
  savePrompt,
  deletePrompt,
} from "./lib/storage/prompts";
import type { Prompt } from "../../src/lib/types";
import { randomUUID } from "crypto";

export default async function handler(req: Request, _context: Context) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const scope = url.searchParams.get("scope");

  try {
    if (req.method === "GET") {
      if (id) {
        const prompt = await getPrompt(id);
        if (!prompt) {
          return new Response(JSON.stringify({ error: "Prompt not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify(prompt), {
          headers: { "Content-Type": "application/json" },
        });
      }
      // List all, optionally filter by scope
      let prompts = await listPrompts();
      if (scope) {
        prompts = prompts.filter(
          (p) => p.scope === "global" || p.scope === scope
        );
      }
      return new Response(JSON.stringify(prompts), {
        headers: { "Content-Type": "application/json" },
      });
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
      return new Response(JSON.stringify(saved), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (req.method === "PUT") {
      if (!id) {
        return new Response(
          JSON.stringify({ error: "Prompt id required" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      const existing = await getPrompt(id);
      if (!existing) {
        return new Response(JSON.stringify({ error: "Prompt not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
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
      return new Response(JSON.stringify(saved), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (req.method === "DELETE") {
      if (!id) {
        return new Response(
          JSON.stringify({ error: "Prompt id required" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      await deletePrompt(id);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("prompts function error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
