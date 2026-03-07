import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { stripCodeBlock } from "../parse-utils";
import type {
  GapAnalysisEntry,
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
- gapAnalysis: Compare the project against industry best practices. Include 8-14 entries across categories like "testing", "security", "performance", "accessibility", "documentation", "ci-cd", "error-handling", "monitoring". Mix of aligned, partial, and gap statuses
- generatedFiles: Generate the full .dev/ folder structure. Always include ALL of these files:

  **context/** (project-specific context):
  - .dev/context/PROJECT.md (ownership: "reviewable") — project overview, stack, architecture, signals
  - .dev/context/CONVENTIONS.md (ownership: "reviewable") — coding conventions, naming patterns, structure
  - .dev/context/DECISIONS.md (ownership: "append-only") — architectural decisions detected

  **industry/** (industry best practices — system-managed):
  - .dev/industry/security.md (ownership: "system") — OWASP-based security practices
  - .dev/industry/testing.md (ownership: "system") — testing approaches & coverage standards
  - Plus one .md per detected technology (e.g., .dev/industry/react.md, .dev/industry/nextjs.md)

  **standards/** (how THIS project does things):
  - .dev/standards/frontend.md (ownership: "reviewable") — frontend patterns for this project
  - .dev/standards/backend.md (ownership: "reviewable") — backend patterns for this project
  - .dev/standards/css.md (ownership: "reviewable") — styling approach for this project
  - .dev/standards/typescript.md (ownership: "reviewable") — TypeScript usage (if applicable)

  **gap-analysis.md** (ownership: "system") — full gap analysis table in markdown

  **prompts/** (scoped prompts):
  - .dev/prompts/audit.md (ownership: "user") — audit prompt scoped to this stack
  - .dev/prompts/cleanup.md (ownership: "user") — cleanup prompt targeting detected issues
  - .dev/prompts/new-feature.md (ownership: "user") — scaffolding matching repo patterns

  **templates/** (code templates):
  - .dev/templates/component.md (ownership: "user") — component template from existing patterns
  - .dev/templates/api-endpoint.md (ownership: "user") — API endpoint template
  - .dev/templates/test.md (ownership: "user") — test template

  **adapters/** (AI tool configs):
  - .dev/adapters/CLAUDE.md (ownership: "user") — Claude Code config pointing to .dev/ files
  - .dev/adapters/.cursorrules (ownership: "user") — Cursor config pointing to .dev/ files

- detectedAdapters: List AI coding tools that likely apply. Options: "claude-code", "cursor", "copilot", "windsurf", "aider", "continue". Include "claude-code" and "cursor" by default

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
