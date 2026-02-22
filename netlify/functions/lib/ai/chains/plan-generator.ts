import { RunnableSequence } from "@langchain/core/runnables";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { PLAN_SYSTEM_PROMPT, buildPlanUserPrompt } from "../prompts/plan-prompt";
import type { ProjectPlan, PlanFeature } from "../../../../../src/lib/types";

interface PlanInput {
  description: string;
  constraints: string;
  goals: string;
  defaultStack: string;
  existingPlan?: string;
}

function parsePlanOutput(raw: string): ProjectPlan {
  // Strip potential markdown code fences
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  const parsed = JSON.parse(cleaned);

  // Validate and normalize
  const features: PlanFeature[] = (parsed.features || []).map(
    (f: Record<string, unknown>) => ({
      name: String(f.name || ""),
      description: String(f.description || ""),
      complexity: ["simple", "medium", "complex"].includes(
        String(f.complexity)
      )
        ? String(f.complexity)
        : "medium",
      phase: f.phase === 2 ? 2 : 1,
      checked: true,
    })
  );

  return {
    projectName: String(parsed.projectName || "my-project"),
    description: String(parsed.description || ""),
    recommendedStack: String(parsed.recommendedStack || ""),
    features,
    deployChecklist: Array.isArray(parsed.deployChecklist)
      ? parsed.deployChecklist.map(String)
      : [],
  };
}

export function createPlanChain(llm: BaseChatModel) {
  return RunnableSequence.from([
    async (input: PlanInput) => {
      const userPrompt = buildPlanUserPrompt(
        input.description,
        input.constraints,
        input.goals,
        input.defaultStack,
        input.existingPlan
      );
      const response = await llm.invoke([
        new SystemMessage(PLAN_SYSTEM_PROMPT),
        new HumanMessage(userPrompt),
      ]);
      return typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);
    },
    (raw: string) => parsePlanOutput(raw),
  ]);
}
