import type { Context } from "@netlify/functions";
import { getLLM } from "./lib/ai/provider";
import { createPlanChain } from "./lib/ai/chains/plan-generator";
import { DEFAULT_STACK } from "../../src/lib/types";
import type { GeneratePlanRequest } from "../../src/lib/types";
import { json, errorResponse, classifyError } from "./lib/responses";

export default async function handler(req: Request, _context: Context) {
  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  try {
    const body = (await req.json()) as GeneratePlanRequest;

    if (!body.description) {
      return errorResponse("Project description is required", 400);
    }

    const llm = getLLM(body.provider || "anthropic");
    const chain = createPlanChain(llm);

    const plan = await chain.invoke({
      description: body.description,
      constraints: body.constraints || "",
      goals: body.goals || "",
      defaultStack: DEFAULT_STACK,
      existingPlan: body.existingPlan
        ? JSON.stringify(body.existingPlan)
        : undefined,
    });

    return json({ plan });
  } catch (err: unknown) {
    console.error("generate function error:", err);
    const { message, status } = classifyError(err, "Failed to generate plan");
    return errorResponse(message, status);
  }
}
