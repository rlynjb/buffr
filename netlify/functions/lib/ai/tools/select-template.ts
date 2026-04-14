import type { AgentTool } from "./types";
import type { BuffrSpecCategory } from "../../../../../src/lib/types";

const SPEC_TYPES: Record<BuffrSpecCategory, { label: string; keywords: string[] }> = {
  features: { label: "Feature Spec", keywords: ["feature", "add", "implement", "build", "create", "new"] },
  bugs: { label: "Bug Report", keywords: ["bug", "fix", "broken", "error", "crash", "issue", "wrong"] },
  tests: { label: "Test Plan", keywords: ["test", "testing", "coverage", "assertion", "spec"] },
  phases: { label: "Phase Plan", keywords: ["phase", "milestone", "roadmap", "plan", "release"] },
  migrations: { label: "Migration Spec", keywords: ["migrate", "migration", "upgrade", "move", "convert"] },
  refactors: { label: "Refactor Spec", keywords: ["refactor", "restructure", "cleanup", "reorganize", "simplify"] },
  prompts: { label: "Prompt Template", keywords: ["prompt", "template", "ai", "llm", "chain"] },
  performance: { label: "Performance Spec", keywords: ["performance", "optimize", "speed", "slow", "latency", "cache"] },
  integrations: { label: "Integration Spec", keywords: ["integrate", "integration", "api", "connect", "webhook", "third-party"] },
};

interface SelectTemplateInput {
  intent: string;
}

interface SelectTemplateOutput {
  category: BuffrSpecCategory;
  label: string;
}

export const selectTemplate: AgentTool = {
  name: "selectTemplate",
  description: "Classifies intent into a spec type. Returns { category, label }.",
  async execute(input: unknown): Promise<SelectTemplateOutput> {
    const { intent } = input as SelectTemplateInput;
    const lower = intent.toLowerCase();

    for (const [category, { label, keywords }] of Object.entries(SPEC_TYPES)) {
      if (keywords.some((kw) => lower.includes(kw))) {
        return { category: category as BuffrSpecCategory, label };
      }
    }

    return { category: "features", label: "Feature Spec" };
  },
};
