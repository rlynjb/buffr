import type { Context } from "@netlify/functions";
import { getLLM } from "./lib/ai/provider";
import { createSummarizeChain } from "./lib/ai/chains/session-summarizer";
import { createIntentChain } from "./lib/ai/chains/intent-detector";
import { createSuggestChain } from "./lib/ai/chains/next-step-suggester";
import { json, errorResponse, classifyError } from "./lib/responses";

export default async function handler(req: Request, _context: Context) {
  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  const url = new URL(req.url);

  try {
    const body = await req.json();
    const provider = (body.provider as string) || "anthropic";
    const llm = getLLM(provider);

    if (url.searchParams.has("summarize")) {
      const chain = createSummarizeChain(llm);
      const result = await chain.invoke({
        activityItems: body.activityItems || [],
      });
      return json(result);
    }

    if (url.searchParams.has("intent")) {
      const chain = createIntentChain(llm);
      const result = await chain.invoke({
        goal: body.goal || "",
        whatChanged: body.whatChanged || "",
        projectPhase: body.projectPhase || "",
      });
      return json(result);
    }

    if (url.searchParams.has("suggest")) {
      const chain = createSuggestChain(llm);
      const result = await chain.invoke({
        goal: body.goal || "",
        whatChanged: body.whatChanged || "",
        currentNextStep: body.currentNextStep || "",
        projectContext: body.projectContext || "",
        openItems: body.openItems || "",
      });
      return json(result);
    }

    return errorResponse("Unknown action. Use ?summarize, ?intent, or ?suggest", 400);
  } catch (err) {
    console.error("session-ai function error:", err);
    const { message, status } = classifyError(err, "Session AI failed");
    return errorResponse(message, status);
  }
}
