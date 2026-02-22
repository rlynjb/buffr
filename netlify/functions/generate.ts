import type { Context } from "@netlify/functions";
import { getLLM } from "./lib/ai/provider";
import { createPlanChain } from "./lib/ai/chains/plan-generator";
import { DEFAULT_STACK } from "../../src/lib/types";
import type { GeneratePlanRequest } from "../../src/lib/types";

export default async function handler(req: Request, _context: Context) {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const body = (await req.json()) as GeneratePlanRequest;

    if (!body.description) {
      return new Response(
        JSON.stringify({ error: "Project description is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
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

    return new Response(JSON.stringify({ plan }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: unknown) {
    console.error("generate function error:", err);

    // Extract a user-friendly message from provider errors
    let message = "Failed to generate plan";
    let status = 500;

    if (err instanceof Error) {
      const msg = err.message;
      if (msg.includes("credit balance is too low") || msg.includes("insufficient")) {
        message = "Your LLM provider account has insufficient credits. Please top up or switch providers.";
        status = 402;
      } else if (msg.includes("authentication") || msg.includes("API key") || msg.includes("Incorrect API key")) {
        message = "Invalid API key for the selected provider. Check your .env file.";
        status = 401;
      } else if (msg.includes("not configured")) {
        message = msg;
        status = 400;
      } else if (msg.includes("rate limit") || msg.includes("Rate limit")) {
        message = "Rate limited by the LLM provider. Wait a moment and try again.";
        status = 429;
      } else {
        message = msg;
      }
    }

    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
