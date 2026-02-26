import { RunnableSequence } from "@langchain/core/runnables";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";

interface PromptChainInput {
  resolvedPrompt: string;
  availableTools?: string[];
}

interface PromptChainOutput {
  text: string;
  suggestedActions?: Array<{ tool: string; params: Record<string, unknown>; label: string }>;
}

const SYSTEM_PROMPT = `You are a helpful developer assistant. Respond to the user's prompt with actionable advice.

If there are follow-up actions the user could take using available tools, include them as suggestedActions in your JSON response. Each action should have a "tool" (tool name), "params" (input parameters), and "label" (short human-readable description).

Return valid JSON: { "text": "your response", "suggestedActions": [...] }
The suggestedActions array is optional — only include it if there are clear follow-up tool actions.`;

function parsePromptOutput(raw: string): PromptChainOutput {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  try {
    const parsed = JSON.parse(cleaned);
    return {
      text: String(parsed.text || ""),
      suggestedActions: Array.isArray(parsed.suggestedActions)
        ? parsed.suggestedActions
        : undefined,
    };
  } catch {
    // If LLM didn't return JSON, treat the whole response as text
    return { text: cleaned };
  }
}

export function createPromptChain(llm: BaseChatModel) {
  return RunnableSequence.from([
    async (input: PromptChainInput) => {
      let systemMsg = SYSTEM_PROMPT;
      if (input.availableTools && input.availableTools.length > 0) {
        systemMsg += `\n\nAvailable tools for suggestedActions: ${input.availableTools.join(", ")}`;
      }

      const response = await llm.invoke([
        new SystemMessage(systemMsg),
        new HumanMessage(input.resolvedPrompt),
      ]);
      return typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);
    },
    (raw: string) => parsePromptOutput(raw),
  ]);
}
