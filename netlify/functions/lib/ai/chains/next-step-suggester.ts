import { RunnableSequence } from "@langchain/core/runnables";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { SUGGEST_SYSTEM_PROMPT, buildSuggestPrompt } from "../prompts/session-prompts";
import { stripCodeBlock } from "../parse-utils";

interface SuggestInput {
  goal: string;
  whatChanged: string;
  currentNextStep: string;
  projectContext: string;
  openItems: string;
}

interface SuggestOutput {
  suggestedNextStep: string;
}

function parseSuggestOutput(raw: string): SuggestOutput {
  const cleaned = stripCodeBlock(raw);
  try {
    const parsed = JSON.parse(cleaned);
    return { suggestedNextStep: String(parsed.suggestedNextStep || "") };
  } catch {
    return { suggestedNextStep: cleaned };
  }
}

export function createSuggestChain(llm: BaseChatModel) {
  return RunnableSequence.from([
    async (input: SuggestInput) => {
      const userPrompt = buildSuggestPrompt(
        input.goal,
        input.whatChanged,
        input.currentNextStep,
        input.projectContext,
        input.openItems,
      );
      const response = await llm.invoke([
        new SystemMessage(SUGGEST_SYSTEM_PROMPT),
        new HumanMessage(userPrompt),
      ]);
      return typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);
    },
    (raw: string) => parseSuggestOutput(raw),
  ]);
}
