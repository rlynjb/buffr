import { RunnableSequence } from "@langchain/core/runnables";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { SUMMARIZE_SYSTEM_PROMPT, buildSummarizePrompt } from "../prompts/session-prompts";

interface SummarizeInput {
  activityItems: Array<{ title: string; source: string; timestamp?: string }>;
}

interface SummarizeOutput {
  bullets: string[];
}

function parseSummarizeOutput(raw: string): SummarizeOutput {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }
  const parsed = JSON.parse(cleaned);
  return {
    bullets: Array.isArray(parsed.bullets) ? parsed.bullets.map(String) : [],
  };
}

export function createSummarizeChain(llm: BaseChatModel) {
  return RunnableSequence.from([
    async (input: SummarizeInput) => {
      const userPrompt = buildSummarizePrompt(input.activityItems);
      const response = await llm.invoke([
        new SystemMessage(SUMMARIZE_SYSTEM_PROMPT),
        new HumanMessage(userPrompt),
      ]);
      return typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);
    },
    (raw: string) => parseSummarizeOutput(raw),
  ]);
}
