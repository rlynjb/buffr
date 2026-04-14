import type { AgentTool } from "./types";
import type { BuffrSpecCategory } from "../../../../../src/lib/types";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";

const TEMPLATES: Record<BuffrSpecCategory, string> = {
  features: `## Overview\n[What this feature does and why it matters]\n\n## Requirements\n- [ ] [Requirement 1]\n\n## Implementation\n[How to build it — key files, data flow, components]\n\n## Edge Cases\n- [Edge case 1]\n\n## Done When\n- [ ] [Acceptance criteria]`,
  bugs: `## Description\n[What's broken]\n\n## Steps to Reproduce\n1. [Step 1]\n\n## Expected vs Actual\n- **Expected:** [what should happen]\n- **Actual:** [what happens]\n\n## Root Cause\n[Analysis]\n\n## Fix\n[Proposed solution]`,
  tests: `## Scope\n[What to test]\n\n## Test Cases\n- [ ] [Test case 1]\n\n## Setup\n[Any test fixtures or mocks needed]\n\n## Coverage Target\n[Which files/functions must be covered]`,
  phases: `## Goal\n[What this phase achieves]\n\n## Steps\n- [ ] [Step 1]\n\n## Dependencies\n[What must be done first]\n\n## Done When\n- [ ] [Acceptance criteria]`,
  migrations: `## From → To\n[Current state → target state]\n\n## Steps\n- [ ] [Step 1]\n\n## Rollback Plan\n[How to revert]\n\n## Data Impact\n[What data is affected]`,
  refactors: `## Motivation\n[Why refactor]\n\n## Current State\n[How it works now]\n\n## Target State\n[How it should work]\n\n## Steps\n- [ ] [Step 1]\n\n## Constraints\n[What must not change]`,
  prompts: `## Purpose\n[What this prompt does]\n\n## System Prompt\n[The system message]\n\n## User Prompt Template\n[Template with variables]\n\n## Expected Output\n[What the LLM should return]`,
  performance: `## Problem\n[What's slow/inefficient]\n\n## Measurement\n[Current metrics]\n\n## Target\n[Desired metrics]\n\n## Approach\n[How to optimize]\n\n## Verification\n[How to measure improvement]`,
  integrations: `## Service\n[What to integrate with]\n\n## API Surface\n[Endpoints/SDK to use]\n\n## Data Flow\n[How data moves between systems]\n\n## Auth\n[How to authenticate]\n\n## Error Handling\n[How to handle failures]`,
};

const SYSTEM_PROMPT = `You are a spec writer for a developer productivity tool. Given a spec template, project context, and the user's intent, fill in the template with specific, actionable content. Use the project context to make the spec grounded in the actual codebase.

Return only the filled-in markdown spec — no JSON wrapping, no preamble.`;

interface BuildSpecInput {
  intent: string;
  category: BuffrSpecCategory;
  context: string;
  answers?: Record<string, string>;
  llm: BaseChatModel;
}

interface BuildSpecOutput {
  title: string;
  content: string;
}

export const buildSpec: AgentTool = {
  name: "buildSpec",
  description: "Generates a filled-in spec from template + context + intent. Returns { title, content }.",
  async execute(input: unknown): Promise<BuildSpecOutput> {
    const { intent, category, context, answers, llm } = input as BuildSpecInput;
    const template = TEMPLATES[category];

    let prompt = `Intent: ${intent}\n\nTemplate:\n${template}\n`;
    if (context) prompt += `\nProject context:\n${context}\n`;
    if (answers && Object.keys(answers).length > 0) {
      prompt += "\nAdditional details:\n";
      for (const [q, a] of Object.entries(answers)) {
        prompt += `- ${q}: ${a}\n`;
      }
    }
    prompt += "\nFill in the template:";

    const response = await llm.invoke([
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(prompt),
    ]);
    const content = typeof response.content === "string"
      ? response.content.trim()
      : JSON.stringify(response.content);

    // Derive title from intent
    const title = intent
      .replace(/^(add|implement|build|create|fix|refactor|migrate|test|optimize)\s+/i, "")
      .split(/[.!?\n]/)[0]
      .trim()
      .slice(0, 80);

    return { title: title || intent.slice(0, 80), content };
  },
};
