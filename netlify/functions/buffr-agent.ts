import type { Context } from "@netlify/functions";
import { getLLM } from "./lib/ai/provider";
import { runSpecAgent } from "./lib/ai/agent";
import { json, errorResponse, classifyError } from "./lib/responses";

export default async function handler(req: Request, _context: Context) {
  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  const url = new URL(req.url);

  try {
    if (url.searchParams.has("buildSpec")) {
      const body = await req.json();
      const { intent, projectId, answers, provider } = body as {
        intent: string;
        projectId: string;
        answers?: Record<string, string>;
        provider?: string;
      };

      if (!intent?.trim()) return errorResponse("intent is required", 400);
      if (!projectId) return errorResponse("projectId is required", 400);

      const llm = getLLM(provider || "anthropic");
      const result = await runSpecAgent({ intent, projectId, answers, llm });

      return json(result);
    }

    return errorResponse("Unknown action. Use ?buildSpec", 400);
  } catch (err) {
    console.error("buffr-agent function error:", err);
    const { message, status } = classifyError(err, "Agent failed");
    return errorResponse(message, status);
  }
}
