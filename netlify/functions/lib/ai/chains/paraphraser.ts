import { RunnableSequence } from "@langchain/core/runnables";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";

const SYSTEM_PROMPT = `You are a concise technical writing assistant. Rewrite the given task description to be clearer and more actionable. Keep it brief (1-2 sentences max). Return only the rewritten text, nothing else.`;

interface ParaphraseInput {
  text: string;
}

interface ParaphraseOutput {
  text: string;
}

export function createParaphraseChain(llm: BaseChatModel) {
  return RunnableSequence.from([
    async (input: ParaphraseInput) => {
      const response = await llm.invoke([
        new SystemMessage(SYSTEM_PROMPT),
        new HumanMessage(input.text),
      ]);
      return typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);
    },
    (raw: string): ParaphraseOutput => ({ text: raw.trim() }),
  ]);
}
