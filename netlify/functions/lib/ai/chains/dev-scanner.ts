import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { stripCodeBlock } from "../parse-utils";
import type {
  GapAnalysisEntry,
  TechDebtItem,
  DetectedPattern,
} from "../../../../../src/lib/types";

export interface DevScanInput {
  projectName: string;
  projectStack: string;
  projectDescription: string;
  projectPhase: string;
  projectGoals: string;
  projectConstraints: string;
  industryStandards: string;
}

export interface DevScanOutput {
  detectedStack: string[];
  detectedPatterns: DetectedPattern[];
  techDebtItems: TechDebtItem[];
  gapAnalysis: GapAnalysisEntry[];
  generatedFiles: { path: string; content: string; ownership: string }[];
  detectedAdapters: string[];
}

const SYSTEM_PROMPT = `You are a senior software architect analyzing a project to generate a .dev/ intelligence folder.

Given the project info and industry best practices, produce a comprehensive analysis as JSON.

Return valid JSON with this exact shape:
{
  "detectedStack": ["tech1", "tech2", ...],
  "detectedPatterns": [
    { "category": "string", "pattern": "string", "confidence": "high"|"medium"|"low", "evidence": ["string"] }
  ],
  "techDebtItems": [
    { "type": "string", "file": "string", "severity": "high"|"medium"|"low", "text": "string" }
  ],
  "gapAnalysis": [
    { "practice": "string", "industry": "string", "project": "string", "status": "aligned"|"partial"|"gap", "category": "string" }
  ],
  "generatedFiles": [
    { "path": "string", "content": "string", "ownership": "system"|"reviewable"|"append-only"|"user" }
  ],
  "detectedAdapters": ["string"]
}

Guidelines:
- detectedStack: Extract individual technologies from the project stack (e.g., "Next.js", "TypeScript", "Tailwind CSS")
- detectedPatterns: Identify 4-8 patterns the project likely uses based on its stack and description. Categories: "architecture", "styling", "state-management", "testing", "deployment", "api-design"
- techDebtItems: Identify 3-6 potential tech debt risks based on the project phase and stack. Use realistic file paths like "src/components/..." or "package.json"
- gapAnalysis: Compare the project against industry best practices. Include 8-12 entries across categories like "testing", "security", "performance", "accessibility", "documentation", "ci-cd", "error-handling", "monitoring". Mix of aligned, partial, and gap statuses
- generatedFiles: Generate 5-8 .dev/ files. Always include:
  - .dev/CONVENTIONS.md (ownership: "reviewable") — coding conventions based on detected stack
  - .dev/ARCHITECTURE.md (ownership: "reviewable") — architecture overview
  - .dev/STANDARDS.md (ownership: "system") — industry standards summary
  - .dev/TECH_DEBT.md (ownership: "append-only") — tech debt inventory
  - .dev/prompts/review.md (ownership: "user") — a code review prompt template
  - .dev/prompts/planning.md (ownership: "user") — a planning prompt template
  Optionally add adapter configs if relevant
- detectedAdapters: List AI coding tools that likely apply. Options: "claude-code", "cursor", "copilot", "windsurf", "aider", "continue". Include "claude-code" and "cursor" by default, add others if the stack suggests them

Make the analysis realistic and specific to the project's actual stack, not generic boilerplate.`;

function parseDevScanOutput(raw: string): DevScanOutput {
  const cleaned = stripCodeBlock(raw);
  const parsed = JSON.parse(cleaned);

  return {
    detectedStack: Array.isArray(parsed.detectedStack)
      ? parsed.detectedStack
      : [],
    detectedPatterns: Array.isArray(parsed.detectedPatterns)
      ? parsed.detectedPatterns
      : [],
    techDebtItems: Array.isArray(parsed.techDebtItems)
      ? parsed.techDebtItems
      : [],
    gapAnalysis: Array.isArray(parsed.gapAnalysis)
      ? parsed.gapAnalysis
      : [],
    generatedFiles: Array.isArray(parsed.generatedFiles)
      ? parsed.generatedFiles
      : [],
    detectedAdapters: Array.isArray(parsed.detectedAdapters)
      ? parsed.detectedAdapters
      : [],
  };
}

export async function runDevScan(
  llm: BaseChatModel,
  input: DevScanInput
): Promise<DevScanOutput> {
  const userPrompt = `Analyze this project and generate the .dev/ intelligence folder:

**Project:** ${input.projectName}
**Stack:** ${input.projectStack}
**Description:** ${input.projectDescription}
**Phase:** ${input.projectPhase}
**Goals:** ${input.projectGoals}
**Constraints:** ${input.projectConstraints}

**Industry Best Practices Reference:**
${input.industryStandards || "(No industry standards loaded — use general best practices)"}

Generate the full analysis JSON now.`;

  const response = await llm.invoke([
    new SystemMessage(SYSTEM_PROMPT),
    new HumanMessage(userPrompt),
  ]);

  const text =
    typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content);

  return parseDevScanOutput(text);
}
