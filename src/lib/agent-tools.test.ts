import { describe, it, expect } from "vitest";
import { selectTemplate } from "../../netlify/functions/lib/ai/tools/select-template";
import { validateSpec } from "../../netlify/functions/lib/ai/tools/validate-spec";

describe("selectTemplate", () => {
  it("classifies feature intent", async () => {
    const result = await selectTemplate.execute({ intent: "Add dark mode toggle" });
    expect(result).toEqual({ category: "features", label: "Feature Spec" });
  });

  it("classifies bug intent", async () => {
    const result = await selectTemplate.execute({ intent: "Fix login crash on empty password" });
    expect(result).toEqual({ category: "bugs", label: "Bug Report" });
  });

  it("classifies refactor intent", async () => {
    const result = await selectTemplate.execute({ intent: "Refactor auth middleware" });
    expect(result).toEqual({ category: "refactors", label: "Refactor Spec" });
  });

  it("classifies migration intent", async () => {
    const result = await selectTemplate.execute({ intent: "Migrate from Blobs to Postgres" });
    expect(result).toEqual({ category: "migrations", label: "Migration Spec" });
  });

  it("classifies performance intent", async () => {
    const result = await selectTemplate.execute({ intent: "Optimize dashboard loading speed" });
    expect(result).toEqual({ category: "performance", label: "Performance Spec" });
  });

  it("defaults to features for unknown intent", async () => {
    const result = await selectTemplate.execute({ intent: "something completely unrelated" });
    expect(result).toEqual({ category: "features", label: "Feature Spec" });
  });
});

describe("validateSpec", () => {
  it("validates a complete feature spec", async () => {
    const content = "## Overview\nSomething\n## Requirements\n- Item\n## Implementation\nCode\n## Done When\n- Done";
    const result = await validateSpec.execute({ content, category: "features" }) as { valid: boolean; gaps: string[] };
    expect(result.valid).toBe(true);
    expect(result.gaps).toEqual([]);
  });

  it("detects missing sections in a feature spec", async () => {
    const content = "## Overview\nSomething";
    const result = await validateSpec.execute({ content, category: "features" }) as { valid: boolean; gaps: string[] };
    expect(result.valid).toBe(false);
    expect(result.gaps).toContain("Requirements");
    expect(result.gaps).toContain("Implementation");
    expect(result.gaps).toContain("Done When");
  });

  it("validates a complete bug report", async () => {
    const content = "## Description\nBroken\n## Steps to Reproduce\n1. Click\n## Expected vs Actual\nWrong\n## Fix\nPatch";
    const result = await validateSpec.execute({ content, category: "bugs" }) as { valid: boolean; gaps: string[] };
    expect(result.valid).toBe(true);
  });

  it("handles empty content", async () => {
    const result = await validateSpec.execute({ content: "", category: "features" }) as { valid: boolean; gaps: string[] };
    expect(result.valid).toBe(false);
    expect(result.gaps.length).toBeGreaterThan(0);
  });
});
