import type { AgentTool } from "./types";
import type { BuffrSpecCategory } from "../../../../../src/lib/types";

const REQUIRED_SECTIONS: Record<BuffrSpecCategory, string[]> = {
  features: ["Overview", "Requirements", "Implementation", "Done When"],
  bugs: ["Description", "Steps to Reproduce", "Expected vs Actual", "Fix"],
  tests: ["Scope", "Test Cases"],
  phases: ["Goal", "Steps", "Done When"],
  migrations: ["From", "Steps", "Rollback Plan"],
  refactors: ["Motivation", "Current State", "Target State", "Steps"],
  prompts: ["Purpose", "System Prompt", "User Prompt"],
  performance: ["Problem", "Target", "Approach"],
  integrations: ["Service", "Data Flow", "Error Handling"],
};

interface ValidateSpecInput {
  content: string;
  category: BuffrSpecCategory;
}

interface ValidateSpecOutput {
  valid: boolean;
  gaps: string[];
}

export const validateSpec: AgentTool = {
  name: "validateSpec",
  description: "Checks spec content for required sections. Returns { valid, gaps[] }.",
  async execute(input: unknown): Promise<ValidateSpecOutput> {
    const { content, category } = input as ValidateSpecInput;
    const required = REQUIRED_SECTIONS[category] || [];
    const lower = content.toLowerCase();
    const gaps: string[] = [];

    for (const section of required) {
      if (!lower.includes(section.toLowerCase())) {
        gaps.push(section);
      }
    }

    return { valid: gaps.length === 0, gaps };
  },
};
