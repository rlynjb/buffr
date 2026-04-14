import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { loadContext } from "./tools/load-context";
import { selectTemplate } from "./tools/select-template";
import { buildSpec } from "./tools/build-spec";
import { validateSpec } from "./tools/validate-spec";
import { saveSpec } from "./tools/save-spec";
import { createConversation, addMessage } from "../storage/conversations";
import type { BuffrSpecCategory } from "../../../../src/lib/types";

interface AgentInput {
  intent: string;
  projectId: string;
  answers?: Record<string, string>;
  llm: BaseChatModel;
}

interface AgentOutput {
  spec: string;
  path: string;
  gaps: string[];
  conversationId: string;
}

export async function runSpecAgent(input: AgentInput): Promise<AgentOutput> {
  const { intent, projectId, answers, llm } = input;

  // Create conversation for tracing
  const conversation = await createConversation(projectId, `Spec: ${intent.slice(0, 60)}`);
  const cid = conversation.id;

  await addMessage(cid, "user", intent);

  // Step 1: Load project context
  const context = await loadContext.execute({ projectId }) as string;
  await addMessage(cid, "tool", context || "(no context available)", { tool: "loadContext" });

  // Step 2: Select template type
  const { category, label } = await selectTemplate.execute({ intent }) as { category: BuffrSpecCategory; label: string };
  await addMessage(cid, "tool", `Selected: ${label} (${category})`, { tool: "selectTemplate" });

  // Step 3: Build spec via LLM
  const { title, content } = await buildSpec.execute({
    intent, category, context, answers, llm,
  }) as { title: string; content: string };
  await addMessage(cid, "assistant", content, { tool: "buildSpec" });

  // Step 4: Validate
  const { valid, gaps } = await validateSpec.execute({ content, category }) as { valid: boolean; gaps: string[] };
  await addMessage(cid, "tool", valid ? "Spec is valid" : `Missing sections: ${gaps.join(", ")}`, { tool: "validateSpec" });

  // Step 5: Save
  const { id, path } = await saveSpec.execute({ projectId, category, title, content }) as { id: string; path: string };
  await addMessage(cid, "tool", `Saved to ${path}`, { tool: "saveSpec" });

  await addMessage(cid, "assistant", `Spec "${title}" created at ${path}${gaps.length > 0 ? ` (missing: ${gaps.join(", ")})` : ""}`);

  return { spec: content, path, gaps, conversationId: cid };
}
