import { RunnableSequence } from "@langchain/core/runnables";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { INTENT_SYSTEM_PROMPT, buildIntentPrompt } from "../prompts/session-prompts";
import { stripCodeBlock } from "../parse-utils";

interface IntentInput {
  goal: string;
  whatChanged: string;
  projectPhase: string;
}

interface IntentOutput {
  intent: string;
}

function parseIntentOutput(raw: string): IntentOutput {
  const cleaned = stripCodeBlock(raw);
  try {
    const parsed = JSON.parse(cleaned);
    return { intent: String(parsed.intent || "") };
  } catch {
    return { intent: cleaned };
  }
}

export function createIntentChain(llm: BaseChatModel) {
  return RunnableSequence.from([
    async (input: IntentInput) => {
      const userPrompt = buildIntentPrompt(input.goal, input.whatChanged, input.projectPhase);
      const response = await llm.invoke([
        new SystemMessage(INTENT_SYSTEM_PROMPT),
        new HumanMessage(userPrompt),
      ]);
      return typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);
    },
    (raw: string) => parseIntentOutput(raw),
  ]);
}
