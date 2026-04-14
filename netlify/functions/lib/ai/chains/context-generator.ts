import { RunnableSequence } from "@langchain/core/runnables";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { stripCodeBlock } from "../parse-utils";

const SYSTEM_PROMPT = `You are a project context generator for a developer productivity tool called buffr.

Given project metadata, session history, and optionally a GitHub repo analysis, generate a structured context document in Markdown.

The document should have these sections:
## Project Overview
One paragraph summarizing what the project is and its current state.

## Tech Stack
Bulleted list of technologies, frameworks, and tools used.

## Architecture
How the codebase is organized — key directories, patterns, data flow.

## Data Model
Key entities and their relationships. Keep it concise.

## What's Stable
Things that are working and should not be changed without good reason.

## Active Work
What's currently being worked on, based on recent sessions.

## Constraints
Important limitations, decisions, or rules to follow.

Return valid JSON: { "title": "...", "content": "..." }
The content should be the full Markdown document. The title should be a short label like "Project Context".`;

interface ContextInput {
  projectName: string;
  projectDescription: string;
  projectStack: string;
  projectPhase: string;
  recentSessions: Array<{ goal: string; whatChanged: string[]; detectedIntent?: string; createdAt: string }>;
  repoAnalysis?: string;
}

interface ContextOutput {
  title: string;
  content: string;
}

function buildPrompt(input: ContextInput): string {
  let prompt = `Project: ${input.projectName}\n`;
  prompt += `Description: ${input.projectDescription}\n`;
  prompt += `Stack: ${input.projectStack}\n`;
  prompt += `Phase: ${input.projectPhase}\n\n`;

  if (input.recentSessions.length > 0) {
    prompt += "Recent sessions:\n";
    for (const s of input.recentSessions.slice(0, 10)) {
      prompt += `- Goal: ${s.goal}`;
      if (s.detectedIntent) prompt += ` (intent: ${s.detectedIntent})`;
      prompt += `\n  Changes: ${s.whatChanged.join(", ")}\n`;
    }
    prompt += "\n";
  }

  if (input.repoAnalysis) {
    prompt += `Repository analysis:\n${input.repoAnalysis}\n`;
  }

  prompt += "\nGenerate the project context document:";
  return prompt;
}

export function createContextChain(llm: BaseChatModel) {
  return RunnableSequence.from([
    async (input: ContextInput) => {
      const response = await llm.invoke([
        new SystemMessage(SYSTEM_PROMPT),
        new HumanMessage(buildPrompt(input)),
      ]);
      return typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);
    },
    (raw: string): ContextOutput => {
      const cleaned = stripCodeBlock(raw);
      try {
        const parsed = JSON.parse(cleaned);
        return {
          title: String(parsed.title || "Project Context"),
          content: String(parsed.content || raw),
        };
      } catch {
        return { title: "Project Context", content: raw.trim() };
      }
    },
  ]);
}
