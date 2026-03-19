import { RunnableSequence } from "@langchain/core/runnables";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";

const DEFAULT_PROMPT = `You are a concise technical writing assistant. Rewrite the given task description to be clearer and more actionable. Keep it brief (1-2 sentences max). Return only the rewritten text, nothing else.`;

const PERSONA_PROMPTS: Record<string, string> = {
  "user-story": `You rewrite task descriptions as user stories. Use the format: "As a [role], I want [goal] so that [benefit]." Keep it to one sentence. Return only the rewritten text.`,
  "backend-dev": `You rewrite task descriptions from a backend developer's perspective. Use technical terms (API, database, middleware, caching, services, schemas, migrations, etc.). Be specific and actionable. Keep it brief (1-2 sentences). Return only the rewritten text.`,
  "frontend-dev": `You rewrite task descriptions from a frontend developer's perspective. Focus on UI/UX, components, state management, styling, accessibility, and user interactions. Be specific and actionable. Keep it brief (1-2 sentences). Return only the rewritten text.`,
  "stakeholder": `You rewrite task descriptions from a stakeholder's perspective. Focus on business value, user impact, and measurable outcomes. Avoid technical jargon. Keep it brief (1-2 sentences). Return only the rewritten text.`,
  "project-manager": `You rewrite task descriptions from a project manager's perspective. Focus on scope, deliverables, acceptance criteria, and dependencies. Be clear and structured. Keep it brief (1-2 sentences). Return only the rewritten text.`,
};

interface ParaphraseInput {
  text: string;
  persona?: string;
}

interface ParaphraseOutput {
  text: string;
}

export function createParaphraseChain(llm: BaseChatModel) {
  return RunnableSequence.from([
    async (input: ParaphraseInput) => {
      const systemPrompt = (input.persona && PERSONA_PROMPTS[input.persona]) || DEFAULT_PROMPT;
      const response = await llm.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage(input.text),
      ]);
      return typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);
    },
    (raw: string): ParaphraseOutput => ({ text: raw.trim() }),
  ]);
}
