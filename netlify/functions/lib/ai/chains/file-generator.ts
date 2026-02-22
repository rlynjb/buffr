import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { getFilePrompt } from "../prompts/file-prompts";

const FILE_SYSTEM_PROMPT = `You are a developer tool that generates project files. You output ONLY the raw file content — no markdown code fences, no explanations, no preamble. Just the file content exactly as it should be written to disk.`;

interface FileGenInput {
  fileType: string;
  projectName: string;
  description: string;
  stack: string;
  features: string[];
  constraints: string;
  goals: string;
}

export async function generateFileContent(
  llm: BaseChatModel,
  input: FileGenInput
): Promise<string> {
  const prompt = getFilePrompt(input.fileType, {
    projectName: input.projectName,
    description: input.description,
    stack: input.stack,
    features: input.features,
    constraints: input.constraints,
    goals: input.goals,
  });

  const response = await llm.invoke([
    new SystemMessage(FILE_SYSTEM_PROMPT),
    new HumanMessage(prompt),
  ]);

  let content =
    typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content);

  // Strip markdown fences if the LLM added them despite instructions
  content = content.trim();
  if (content.startsWith("```")) {
    content = content.replace(/^```(?:\w+)?\n?/, "").replace(/\n?```$/, "");
  }

  return content;
}
