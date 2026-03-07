import type { Context } from "@netlify/functions";
import { randomUUID } from "crypto";
import { getLLM, getDefaultProvider } from "./lib/ai/provider";
import { runDevScan, type DevScanOutput } from "./lib/ai/chains/dev-scanner";
import { getProject, saveProject } from "./lib/storage/projects";
import { getScanResult, saveScanResult } from "./lib/storage/scan-results";
import { listStandards } from "./lib/storage/industry-kb";
import { seedIndustryKB } from "./lib/industry-kb/seed";
import {
  analyzeRepo,
  getRepoInfo,
  getCommits,
  getFileContent,
  pushFiles,
} from "./lib/github";
import { json, errorResponse, classifyError } from "./lib/responses";
import type {
  ScanResult,
  Project,
  GapAnalysisEntry,
  DetectedPattern,
  ScanResultFile,
  IndustryStandard,
} from "../../src/lib/types";

/* ── helpers ── */

function detectKBTokens(stack: string[]): string[] {
  const map: Record<string, string[]> = {
    react: ["React", "Next.js"],
    nextjs: ["Next.js"],
    typescript: ["TypeScript"],
    tailwind: ["Tailwind CSS"],
    nodejs: ["Node.js", "Express", "Fastify", "Hono"],
  };
  const tokens: string[] = [];
  for (const [key, labels] of Object.entries(map)) {
    if (labels.some((l) => stack.includes(l))) tokens.push(key);
  }
  // Always include nodejs for JS projects
  if (stack.length > 0 && !tokens.includes("nodejs")) tokens.push("nodejs");
  return tokens;
}

function emptyScanResult(
  id: string,
  projectId: string,
  repoFullName: string
): ScanResult {
  const now = new Date().toISOString();
  return {
    id,
    projectId,
    repoFullName,
    status: "scanning",
    detectedStack: [],
    fileTree: [],
    parsedConfigs: [],
    detectedPatterns: [],
    techDebtItems: [], // deprecated — tech debt now lives on Project.techDebt
    gitActivity: { recentCommits: 0, activePaths: [], lastCommitDate: now },
    generatedFiles: [],
    gapAnalysis: [],
    detectedAdapters: [],
    error: null,
    createdAt: now,
    updatedAt: now,
  };
}

/* ── rule-based analysis from real repo data ── */

interface RepoAnalysis {
  detectedStack: string;
  frameworks: string[];
  devTools: string[];
  hasTests: boolean;
  hasCI: boolean;
  hasDeployConfig: boolean;
  fileCount: number;
  detectedPhase: string;
}

function buildPatterns(analysis: RepoAnalysis, files: string[]): DetectedPattern[] {
  const patterns: DetectedPattern[] = [];
  const { frameworks } = analysis;

  if (frameworks.includes("Next.js")) {
    const hasAppDir = files.some((f) => f.startsWith("app/") || f.startsWith("src/app/"));
    patterns.push({
      category: "architecture",
      pattern: hasAppDir ? "Next.js App Router" : "Next.js Pages Router",
      confidence: "high",
      evidence: hasAppDir
        ? files.filter((f) => f.includes("/app/")).slice(0, 3)
        : files.filter((f) => f.includes("/pages/")).slice(0, 3),
    });
  }

  if (frameworks.includes("Tailwind CSS")) {
    const cssFiles = files.filter((f) => f.endsWith(".css"));
    patterns.push({
      category: "styling",
      pattern: "Tailwind CSS",
      confidence: "high",
      evidence: cssFiles.slice(0, 3),
    });
  }

  if (frameworks.includes("TypeScript")) {
    patterns.push({
      category: "architecture",
      pattern: "TypeScript",
      confidence: "high",
      evidence: files.filter((f) => f.endsWith(".ts") || f.endsWith(".tsx")).slice(0, 3),
    });
  }

  const netlifyFns = files.filter((f) => f.startsWith("netlify/functions/"));
  if (netlifyFns.length > 0) {
    patterns.push({
      category: "api-design",
      pattern: "Netlify serverless functions",
      confidence: "high",
      evidence: netlifyFns.slice(0, 3),
    });
  }

  const hasRedux = analysis.devTools.includes("Redux") || files.some((f) => f.includes("store") && f.endsWith(".ts"));
  if (hasRedux) {
    patterns.push({ category: "state-management", pattern: "Redux / global store", confidence: "medium", evidence: ["store file detected"] });
  } else if (frameworks.includes("React") || frameworks.includes("Next.js")) {
    patterns.push({ category: "state-management", pattern: "React hooks (local state)", confidence: "medium", evidence: ["No global state library detected"] });
  }

  if (analysis.hasDeployConfig) {
    const deployFiles = files.filter((f) =>
      ["netlify.toml", "vercel.json", "fly.toml", "Dockerfile", "docker-compose.yml"].includes(f)
    );
    patterns.push({
      category: "deployment",
      pattern: deployFiles.join(", ") || "Deploy config detected",
      confidence: "high",
      evidence: deployFiles,
    });
  }

  return patterns;
}

function buildGapAnalysis(analysis: RepoAnalysis, files: string[]): GapAnalysisEntry[] {
  const entries: GapAnalysisEntry[] = [];

  // TypeScript strict mode
  if (analysis.frameworks.includes("TypeScript")) {
    entries.push({
      practice: "Type safety",
      industry: "Strict TypeScript with no implicit any",
      project: "TypeScript enabled",
      status: "aligned",
      category: "architecture",
    });
  }

  // Component architecture
  if (analysis.frameworks.includes("React") || analysis.frameworks.includes("Next.js")) {
    const componentFiles = files.filter((f) => f.includes("components/") && (f.endsWith(".tsx") || f.endsWith(".jsx")));
    entries.push({
      practice: "Component architecture",
      industry: "Small, focused components with single responsibility",
      project: componentFiles.length > 0
        ? `${componentFiles.length} component files detected`
        : "No components directory found",
      status: componentFiles.length > 0 ? "aligned" : "gap",
      category: "architecture",
    });
  }

  // Testing
  entries.push({
    practice: "Unit testing",
    industry: "Test coverage with React Testing Library / Vitest",
    project: analysis.hasTests ? `${analysis.devTools.filter((t) => ["Jest", "Vitest", "Mocha", "Testing Library"].includes(t)).join(", ")} detected` : "No test framework detected",
    status: analysis.hasTests ? "aligned" : "gap",
    category: "testing",
  });

  const hasE2E = analysis.devTools.some((t) => ["Cypress", "Playwright"].includes(t));
  entries.push({
    practice: "E2E testing",
    industry: "Critical user paths covered with Playwright or Cypress",
    project: hasE2E ? "E2E framework detected" : "No E2E test setup",
    status: hasE2E ? "aligned" : "gap",
    category: "testing",
  });

  // CI/CD
  entries.push({
    practice: "CI/CD pipeline",
    industry: "Automated lint, type-check, test, deploy",
    project: analysis.hasCI ? "CI workflow detected" : "No CI pipeline",
    status: analysis.hasCI ? "aligned" : "gap",
    category: "ci-cd",
  });

  // Error handling
  const hasErrorFiles = files.some((f) => f.includes("error.tsx"));
  entries.push({
    practice: "Error handling",
    industry: "Route-level error boundaries + global fallback",
    project: hasErrorFiles ? "error.tsx boundaries found" : "No error boundaries",
    status: hasErrorFiles ? "aligned" : files.some((f) => f.includes("try") || f.endsWith(".ts")) ? "partial" : "gap",
    category: "error-handling",
  });

  // Security — auth
  const hasAuth = files.some((f) => f.includes("auth") || f.includes("middleware"));
  entries.push({
    practice: "Authentication",
    industry: "Auth middleware on protected endpoints",
    project: hasAuth ? "Auth-related files detected" : "No auth layer detected",
    status: hasAuth ? "partial" : "gap",
    category: "security",
  });

  // Security — validation
  const hasValidation = files.some((f) => f.includes("schema") || f.includes("validation") || f.includes("zod"));
  entries.push({
    practice: "Input validation",
    industry: "Schema validation on all API inputs (Zod/Joi)",
    project: hasValidation ? "Validation files detected" : "No schema validation detected",
    status: hasValidation ? "aligned" : "partial",
    category: "security",
  });

  // Accessibility
  entries.push({
    practice: "Accessibility",
    industry: "WCAG AA compliance, semantic HTML, ARIA labels",
    project: "Requires manual audit",
    status: "partial",
    category: "accessibility",
  });

  // Deploy
  entries.push({
    practice: "Deploy configuration",
    industry: "Reproducible deploy with config-as-code",
    project: analysis.hasDeployConfig ? "Deploy config detected" : "No deploy config",
    status: analysis.hasDeployConfig ? "aligned" : "gap",
    category: "deployment",
  });

  // Monitoring
  const hasMonitoring = files.some((f) => f.includes("sentry") || f.includes("analytics") || f.includes("monitoring"));
  entries.push({
    practice: "Monitoring & observability",
    industry: "Error tracking, performance monitoring, logging",
    project: hasMonitoring ? "Monitoring setup detected" : "No monitoring detected",
    status: hasMonitoring ? "aligned" : "gap",
    category: "monitoring",
  });

  // Documentation
  const hasReadme = files.some((f) => f.toLowerCase() === "readme.md");
  const hasDocs = files.some((f) => f.startsWith("docs/"));
  entries.push({
    practice: "Documentation",
    industry: "README, API docs, architecture decision records",
    project: hasDocs ? "docs/ directory found" : hasReadme ? "README present" : "No documentation",
    status: hasDocs ? "aligned" : hasReadme ? "partial" : "gap",
    category: "documentation",
  });

  return entries;
}

function buildGeneratedFiles(
  project: Project,
  analysis: RepoAnalysis,
  gapAnalysis: GapAnalysisEntry[],
  relevantStandards: IndustryStandard[],
  detectedAdapters: string[],
): { path: string; content: string; ownership: string }[] {
  const stackStr = analysis.detectedStack || project.stack || "Unknown";
  const devToolsStr = analysis.devTools.length > 0 ? analysis.devTools.join(", ") : "None detected";
  const files: { path: string; content: string; ownership: string }[] = [];

  // ── context/ ──────────────────────────────────────────────

  files.push({
    path: ".dev/context/PROJECT.md",
    ownership: "reviewable",
    content: [
      "# Project Overview",
      "",
      `**Name:** ${project.name}`,
      `**Description:** ${project.description || "—"}`,
      `**Phase:** ${analysis.detectedPhase} (${analysis.fileCount} files)`,
      "",
      "## Stack",
      ...analysis.frameworks.map((f) => `- ${f}`),
      "",
      "## Dev Tools",
      devToolsStr !== "None detected" ? analysis.devTools.map((t) => `- ${t}`).join("\n") : "- None detected",
      "",
      "## Signals",
      `- Tests: ${analysis.hasTests ? "Yes" : "No"}`,
      `- CI/CD: ${analysis.hasCI ? "Yes" : "No"}`,
      `- Deploy config: ${analysis.hasDeployConfig ? "Yes" : "No"}`,
      "",
    ].join("\n"),
  });

  files.push({
    path: ".dev/context/CONVENTIONS.md",
    ownership: "reviewable",
    content: [
      "# Coding Conventions",
      "",
      ...(analysis.frameworks.includes("TypeScript")
        ? ["## TypeScript", "- Use strict TypeScript — avoid `any`, prefer `unknown` for untyped values", "- Define return types for public API functions", "- Use discriminated unions for state variants", ""]
        : []),
      ...(analysis.frameworks.includes("React") || analysis.frameworks.includes("Next.js")
        ? ["## React", "- Prefer function components with hooks", "- Use named exports for components", "- Co-locate component files (tsx, css, test)", "- Extract reusable logic into custom hooks", ""]
        : []),
      ...(analysis.frameworks.includes("Tailwind CSS")
        ? ["## CSS / Styling", "- Use `@apply` in co-located CSS files with BEM naming", "- Use `@reference` for Tailwind class resolution in co-located CSS", "- Group classes: layout → spacing → color → typography", ""]
        : []),
      ...(analysis.frameworks.includes("Next.js")
        ? ["## Next.js", "- Use App Router patterns: layout.tsx, loading.tsx, error.tsx", "- Fetch data in Server Components when possible", "- Use route groups for shared layouts", ""]
        : []),
    ].join("\n"),
  });

  files.push({
    path: ".dev/context/DECISIONS.md",
    ownership: "append-only",
    content: [
      "# Architectural Decisions",
      "",
      "<!-- buffr appends new entries here — it never edits or removes existing ones -->",
      "",
      `## ADR-001: ${analysis.frameworks.includes("Next.js") ? "App Router" : analysis.frameworks[0] || "Framework"} chosen`,
      `- **Date:** ${new Date().toISOString().split("T")[0]}`,
      `- **Status:** Detected`,
      `- **Context:** Project uses ${analysis.frameworks.join(", ") || "unknown stack"}`,
      `- **Decision:** ${analysis.frameworks.includes("Next.js") ? "Next.js App Router architecture with React Server Components" : `${analysis.frameworks[0] || "Current"} stack as primary framework`}`,
      "",
      ...(analysis.hasDeployConfig
        ? [`## ADR-002: Deployment platform`, `- **Date:** ${new Date().toISOString().split("T")[0]}`, `- **Status:** Detected`, `- **Context:** Deploy configuration detected in repository`, `- **Decision:** Using platform-specific deploy config`, ""]
        : []),
    ].join("\n"),
  });

  // ── industry/ ─────────────────────────────────────────────

  const standardsByTech = new Map(relevantStandards.map((s) => [s.technology, s]));
  const industryMap: [string, string, string][] = [
    ["react", "react.md", "React"],
    ["nextjs", "nextjs.md", "Next.js"],
    ["tailwind", "tailwind.md", "Tailwind CSS"],
    ["typescript", "typescript.md", "TypeScript"],
    ["nodejs", "nodejs.md", "Node.js"],
  ];

  for (const [tech, filename, label] of industryMap) {
    const standard = standardsByTech.get(tech);
    if (standard) {
      files.push({
        path: `.dev/industry/${filename}`,
        ownership: "system",
        content: standard.content,
      });
    } else if (analysis.frameworks.some((f) => f.includes(label))) {
      files.push({
        path: `.dev/industry/${filename}`,
        ownership: "system",
        content: `# ${label} Best Practices\n\nIndustry standards for ${label}. Seed the industry KB for detailed content.\n`,
      });
    }
  }

  // Always include security and testing standards
  files.push({
    path: ".dev/industry/security.md",
    ownership: "system",
    content: [
      "# Security Best Practices",
      "",
      "## Input Validation",
      "- Validate and sanitize all user input at system boundaries",
      "- Use schema validation (Zod, Joi) on API inputs",
      "- Never interpolate user input into queries",
      "",
      "## Authentication & Authorization",
      "- Use auth middleware on protected endpoints",
      "- Store secrets in environment variables, never in code",
      "- Implement CSRF protection for state-changing operations",
      "",
      "## Dependencies",
      "- Run `npm audit` regularly",
      "- Keep dependencies updated",
      "- Pin dependency versions for reproducible builds",
      "",
      "## Headers & Transport",
      "- Use HTTPS everywhere",
      "- Set appropriate CORS headers",
      "- Add security headers (Content-Security-Policy, X-Frame-Options)",
      "",
    ].join("\n"),
  });

  files.push({
    path: ".dev/industry/testing.md",
    ownership: "system",
    content: [
      "# Testing Standards",
      "",
      "## Unit Tests",
      "- Test behavior, not implementation details",
      "- Use React Testing Library for component tests",
      "- Mock at the network boundary (MSW), not at the module level",
      "",
      "## Integration Tests",
      "- Test API endpoints with realistic request/response cycles",
      "- Use test databases or in-memory stores for isolation",
      "",
      "## E2E Tests",
      "- Cover critical user paths with Playwright or Cypress",
      "- Run E2E in CI before deployment",
      "",
      "## Coverage",
      "- Aim for high confidence, not high coverage numbers",
      "- Focus testing effort on complex business logic and error paths",
      "",
    ].join("\n"),
  });

  // ── standards/ ────────────────────────────────────────────

  files.push({
    path: ".dev/standards/frontend.md",
    ownership: "reviewable",
    content: [
      "# Frontend Standards",
      "",
      `This project uses ${analysis.frameworks.filter((f) => ["React", "Next.js", "Vue", "Angular", "Svelte"].includes(f)).join(", ") || "a frontend framework"}.`,
      "",
      "## Component Architecture",
      analysis.frameworks.includes("Next.js")
        ? "- Use Server Components by default, `\"use client\"` only when needed"
        : "- Organize components by feature, not by type",
      "- Keep components focused on a single responsibility",
      "- Extract shared logic into custom hooks",
      "",
      "## Routing",
      analysis.frameworks.includes("Next.js")
        ? "- File-based routing with App Router\n- Use layout.tsx for persistent UI\n- Use loading.tsx and error.tsx for UX"
        : "- Consistent routing patterns across the app",
      "",
      "## Data Fetching",
      analysis.frameworks.includes("Next.js")
        ? "- Fetch data in Server Components when possible\n- Use SWR or TanStack Query for client-side real-time data"
        : "- Centralize API calls in a service layer",
      "",
    ].join("\n"),
  });

  files.push({
    path: ".dev/standards/backend.md",
    ownership: "reviewable",
    content: [
      "# Backend Standards",
      "",
      analysis.frameworks.includes("Next.js")
        ? "This project uses Next.js API routes / serverless functions."
        : `This project's backend uses ${analysis.devTools.join(", ") || "Node.js"}.`,
      "",
      "## API Design",
      "- Return consistent response shapes: `{ data }` on success, `{ error }` on failure",
      "- Use appropriate HTTP status codes (200, 201, 400, 401, 404, 500)",
      "- Validate request bodies before processing",
      "",
      "## Error Handling",
      "- Classify errors and map to HTTP status codes",
      "- Log errors with context (request ID, operation name)",
      "- Never expose stack traces to clients",
      "",
      "## Security",
      "- Validate all inputs at the boundary",
      "- Use environment variables for secrets",
      "- Add rate limiting for public endpoints",
      "",
    ].join("\n"),
  });

  files.push({
    path: ".dev/standards/css.md",
    ownership: "reviewable",
    content: [
      "# CSS / Styling Standards",
      "",
      analysis.frameworks.includes("Tailwind CSS")
        ? [
            "This project uses Tailwind CSS.",
            "",
            "## Approach",
            "- Use `@apply` in co-located `.css` files with BEM naming",
            "- Use `@reference` directive for Tailwind v4 class resolution",
            "- Group utility classes: layout → spacing → color → typography",
            "",
            "## Component Styles",
            "- Co-locate CSS files with their components: `component.tsx` + `component.css`",
            "- Use BEM naming: `.block`, `.block__element`, `.block--modifier`",
            "- Prefer `@apply` in CSS files over long utility class strings in JSX",
          ].join("\n")
        : "This project uses standard CSS. Follow existing patterns for consistency.",
      "",
      "## Design Tokens",
      "- Define colors, spacing, and typography in the theme configuration",
      "- Use CSS variables for dynamic values",
      "- Maintain a consistent spacing scale",
      "",
    ].join("\n"),
  });

  if (analysis.frameworks.includes("TypeScript")) {
    files.push({
      path: ".dev/standards/typescript.md",
      ownership: "reviewable",
      content: [
        "# TypeScript Standards",
        "",
        "## Type Safety",
        "- Enable `strict: true` in tsconfig.json",
        "- Avoid `any` — use `unknown` when the type is truly unknown",
        "- Prefer `interface` for object shapes, `type` for unions",
        "- Define return types for exported functions",
        "",
        "## Naming",
        "- PascalCase for types, interfaces, and components",
        "- camelCase for variables, functions, and properties",
        "- Use descriptive names — avoid abbreviations",
        "",
        "## Patterns",
        "- Use discriminated unions for state variants",
        "- Use `satisfies` for type checking without widening",
        "- Export types alongside their implementations",
        "",
      ].join("\n"),
    });
  }

  // ── gap-analysis.md ───────────────────────────────────────

  const gapRows = gapAnalysis.map(
    (g) => `| ${g.practice} | ${g.industry} | ${g.project} | ${g.status === "aligned" ? "Aligned" : g.status === "partial" ? "Partial" : "Gap"} |`
  );

  files.push({
    path: ".dev/gap-analysis.md",
    ownership: "system",
    content: [
      "# Gap Analysis",
      "",
      "Industry best practices vs. this project's current state.",
      "",
      "| Practice | Industry Standard | This Project | Status |",
      "|----------|-------------------|--------------|--------|",
      ...gapRows,
      "",
      `**Summary:** ${gapAnalysis.filter((g) => g.status === "aligned").length} aligned, ${gapAnalysis.filter((g) => g.status === "partial").length} partial, ${gapAnalysis.filter((g) => g.status === "gap").length} gaps`,
      "",
    ].join("\n"),
  });

  // ── prompts/ ──────────────────────────────────────────────

  files.push({
    path: ".dev/prompts/audit.md",
    ownership: "user",
    content: [
      "# Code Audit Prompt",
      "",
      `Audit this ${stackStr} project for quality, security, and best practice compliance.`,
      "",
      "## Focus Areas",
      analysis.frameworks.includes("TypeScript") ? "1. Type safety — find `any` escapes, missing return types, unsafe casts" : "1. Code quality — find anti-patterns and code smells",
      analysis.frameworks.includes("React") || analysis.frameworks.includes("Next.js") ? "2. Component health — oversized components, prop drilling, missing error boundaries" : "2. Module structure — coupling, cohesion, separation of concerns",
      "3. Security — input validation, auth checks, secret exposure",
      "4. Performance — unnecessary re-renders, missing memoization, bundle size",
      "5. Accessibility — ARIA labels, semantic HTML, keyboard navigation",
      "",
      "## Output",
      "For each finding: file path, line number, severity (high/medium/low), and recommended fix.",
      "",
    ].join("\n"),
  });

  files.push({
    path: ".dev/prompts/cleanup.md",
    ownership: "user",
    content: [
      "# Cleanup Prompt",
      "",
      `Clean up issues detected in this ${stackStr} project.`,
      "",
      "## Instructions",
      "1. Review the gap analysis in `.dev/gap-analysis.md` for areas needing improvement",
      "2. Fix each issue following the project conventions in `.dev/context/CONVENTIONS.md`",
      "3. Ensure changes align with standards in `.dev/standards/`",
      "4. Add or update tests for modified code",
      "5. Keep changes minimal and focused",
      "",
    ].join("\n"),
  });

  files.push({
    path: ".dev/prompts/new-feature.md",
    ownership: "user",
    content: [
      "# New Feature Scaffold Prompt",
      "",
      `Scaffold a new feature for this ${stackStr} project.`,
      "",
      "## Context",
      "- Read `.dev/context/PROJECT.md` for project overview",
      "- Follow `.dev/context/CONVENTIONS.md` for naming and structure",
      "- Check `.dev/standards/` for technology-specific patterns",
      "",
      "## Requirements",
      "- [Describe the feature here]",
      "",
      "## Expected Output",
      analysis.frameworks.includes("Next.js")
        ? "1. Route file(s) in `src/app/`\n2. Component(s) in `src/components/`\n3. Co-located CSS with BEM naming\n4. API endpoint(s) if needed\n5. Type definitions in `src/lib/types.ts`"
        : "1. Component/module files\n2. Associated styles\n3. Type definitions\n4. Tests",
      "",
    ].join("\n"),
  });

  // ── templates/ ────────────────────────────────────────────

  files.push({
    path: ".dev/templates/component.md",
    ownership: "user",
    content: analysis.frameworks.includes("React") || analysis.frameworks.includes("Next.js")
      ? [
          "# Component Template",
          "",
          "```tsx",
          analysis.frameworks.includes("Next.js") ? '"use client";\n' : "",
          'import "./{name}.css";',
          "",
          "interface {Name}Props {",
          "  // props here",
          "}",
          "",
          "export function {Name}({ }: {Name}Props) {",
          "  return (",
          '    <div className="{name}">',
          "      {/* content */}",
          "    </div>",
          "  );",
          "}",
          "```",
          "",
          "```css",
          "/* {name}.css */",
          analysis.frameworks.includes("Tailwind CSS")
            ? '@reference "tailwindcss";\n\n.{name} {\n  @apply /* styles */;\n}'
            : ".{name} {\n  /* styles */\n}",
          "```",
          "",
        ].join("\n")
      : "# Component Template\n\nAdd your component template here matching the project's patterns.\n",
  });

  files.push({
    path: ".dev/templates/api-endpoint.md",
    ownership: "user",
    content: [
      "# API Endpoint Template",
      "",
      "```ts",
      'import type { Context } from "@netlify/functions";',
      'import { json, errorResponse } from "./lib/responses";',
      "",
      "export default async function handler(req: Request, _context: Context) {",
      '  if (req.method === "GET") {',
      "    // Handle GET",
      "    return json({ data: [] });",
      "  }",
      "",
      '  if (req.method === "POST") {',
      "    const body = await req.json();",
      "    // Validate input",
      "    // Process request",
      "    return json({ data: body });",
      "  }",
      "",
      '  return errorResponse("Method not allowed", 405);',
      "}",
      "```",
      "",
    ].join("\n"),
  });

  files.push({
    path: ".dev/templates/test.md",
    ownership: "user",
    content: [
      "# Test Template",
      "",
      "```ts",
      'import { describe, it, expect } from "vitest";',
      "",
      'describe("{Name}", () => {',
      '  it("should {behavior}", () => {',
      "    // Arrange",
      "    // Act",
      "    // Assert",
      "    expect(true).toBe(true);",
      "  });",
      "});",
      "```",
      "",
      "## Guidelines",
      "- Test behavior, not implementation",
      "- One assertion per test when possible",
      "- Use descriptive test names that read as sentences",
      "",
    ].join("\n"),
  });

  // ── adapters/ ─────────────────────────────────────────────

  const devFiles = files.map((f) => f.path).join(", ");

  if (detectedAdapters.includes("claude-code") || detectedAdapters.length === 0) {
    files.push({
      path: ".dev/adapters/CLAUDE.md",
      ownership: "user",
      content: [
        "# Claude Code Project Config",
        "",
        "Read the following .dev/ files for project context:",
        "",
        "- `.dev/context/PROJECT.md` — Project overview and architecture",
        "- `.dev/context/CONVENTIONS.md` — Coding conventions to follow",
        "- `.dev/context/TECH_DEBT.md` — Known tech debt to be aware of",
        "- `.dev/standards/` — Technology-specific standards for this project",
        "- `.dev/gap-analysis.md` — Industry vs project gap analysis",
        "",
        "When writing code, follow the conventions and standards defined in these files.",
        "When reviewing code, check against the gap analysis for improvement opportunities.",
        "",
      ].join("\n"),
    });
  }

  if (detectedAdapters.includes("cursor") || detectedAdapters.length === 0) {
    files.push({
      path: ".dev/adapters/.cursorrules",
      ownership: "user",
      content: [
        "# Cursor Rules — Auto-generated by buffr",
        "",
        "# Read .dev/ for project intelligence:",
        "# - .dev/context/PROJECT.md for project overview",
        "# - .dev/context/CONVENTIONS.md for coding standards",
        "# - .dev/standards/ for technology-specific patterns",
        "",
        `This is a ${stackStr} project.`,
        "",
        analysis.frameworks.includes("TypeScript") ? "Use strict TypeScript. Avoid `any`." : "",
        analysis.frameworks.includes("React") || analysis.frameworks.includes("Next.js") ? "Use function components with hooks. Use named exports." : "",
        analysis.frameworks.includes("Tailwind CSS") ? "Use @apply in co-located CSS files with BEM naming." : "",
        analysis.frameworks.includes("Next.js") ? "Use App Router patterns. Prefer Server Components." : "",
        "",
      ].filter(Boolean).join("\n"),
    });
  }

  return files;
}

function detectAdapters(files: string[]): string[] {
  const adapters: string[] = [];
  const checks: [string, (f: string) => boolean][] = [
    ["claude-code", (f) => f === "CLAUDE.md" || f === ".claude" || f.startsWith(".claude/")],
    ["cursor", (f) => f === ".cursorrules" || f.startsWith(".cursor/")],
    ["copilot", (f) => f === ".github/copilot-instructions.md" || f.startsWith(".github/copilot")],
    ["windsurf", (f) => f === ".windsurfrules" || f.startsWith(".windsurf/")],
    ["aider", (f) => f === ".aider.conf.yml" || f === ".aiderignore"],
    ["continue", (f) => f === ".continuerules" || f.startsWith(".continue/")],
  ];
  for (const [name, check] of checks) {
    if (files.some(check)) adapters.push(name);
  }
  return adapters;
}

/* ── handler ── */

export default async function handler(req: Request, _context: Context) {
  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  const url = new URL(req.url);

  try {
    const body = await req.json();

    // ── Push existing scan files to repo ──
    if (url.searchParams.has("push")) {
      const { scanResultId } = body as { scanResultId: string };
      if (!scanResultId) return errorResponse("scanResultId is required", 400);

      const scan = await getScanResult(scanResultId);
      if (!scan) return errorResponse("Scan result not found", 404);
      if (!scan.generatedFiles.length) return errorResponse("No files to push", 400);

      const repoFullName = scan.repoFullName;
      if (!repoFullName || !repoFullName.includes("/")) {
        return errorResponse("No GitHub repo linked", 400);
      }
      const [o, r] = repoFullName.split("/");

      const sha = await pushFiles(
        o,
        r,
        scan.generatedFiles.map((f) => ({ path: f.path, content: f.content })),
        "chore: update .dev/ project intelligence folder"
      );
      return json({ sha });
    }

    // ── Generate scan ──
    const { projectId, provider, skipPush } = body as {
      projectId: string;
      provider?: string;
      skipPush?: boolean;
    };

    if (!projectId) return errorResponse("projectId is required", 400);

    const project = await getProject(projectId);
    if (!project) return errorResponse("Project not found", 404);

    const repoFullName = project.githubRepo || "";
    if (!repoFullName || !repoFullName.includes("/")) {
      return errorResponse("Project has no GitHub repo linked. Connect a repo first.", 400);
    }

    const scanId = randomUUID();
    const scan = emptyScanResult(scanId, projectId, repoFullName);

    // Save initial "scanning" state
    await saveScanResult(scan);

    // ── Phase 1: Scan repo via GitHub API ──
    const [owner, repo] = repoFullName.split("/");
    const repoInfo = await getRepoInfo(repoFullName);
    const branch = repoInfo?.defaultBranch || "main";

    const [analysis, commits] = await Promise.all([
      analyzeRepo(owner, repo, branch),
      getCommits(owner, repo, undefined, 30),
    ]);

    // Read key config files
    const configFiles = ["package.json", "tsconfig.json", "netlify.toml", "next.config.js", "next.config.ts", "next.config.mjs"];
    const parsedConfigs: { file: string; content: Record<string, unknown> }[] = [];
    for (const cf of configFiles) {
      const raw = await getFileContent(owner, repo, cf, branch);
      if (raw) {
        try {
          parsedConfigs.push({ file: cf, content: JSON.parse(raw) });
        } catch {
          // Not JSON (e.g., next.config.mjs) — skip parsing
        }
      }
    }

    // Build file tree from the repo analysis
    scan.detectedStack = analysis.frameworks;
    scan.parsedConfigs = parsedConfigs;
    scan.gitActivity = {
      recentCommits: commits.length,
      activePaths: [...new Set(commits.flatMap((c) => c.files || []))].slice(0, 20),
      lastCommitDate: commits[0]?.date || new Date().toISOString(),
    };

    // Update to "analyzing"
    scan.status = "analyzing";
    scan.updatedAt = new Date().toISOString();
    await saveScanResult(scan);

    // ── Phase 2: Analyze ──
    // Seed industry KB and load relevant standards
    await seedIndustryKB(false);
    const kbTokens = detectKBTokens(analysis.frameworks);
    const allStandards = await listStandards();
    const relevant = allStandards.filter((s) => kbTokens.includes(s.technology));
    const standardsText = relevant.map((s) => s.content).join("\n\n---\n\n");

    // Try LLM analysis first, fall back to rule-based
    let result: DevScanOutput | null = null;
    try {
      const llm = getLLM(provider || getDefaultProvider());
      result = await runDevScan(llm, {
        projectName: project.name,
        projectStack: analysis.detectedStack,
        projectDescription: project.description,
        projectPhase: project.phase,
        projectGoals: project.goals,
        projectConstraints: project.constraints,
        industryStandards: standardsText,
      });
    } catch (llmErr) {
      console.warn("LLM unavailable, using rule-based analysis:", (llmErr as Error).message);
    }

    // Get the full file list for rule-based analysis
    // (analyzeRepo already fetched it; we re-derive from the repo tree endpoint)
    let repoFiles: string[] = [];
    try {
      const { gh: _gh, ..._ } = {} as Record<string, unknown>; // avoid shadowing
      const treeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=true`, {
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
        },
      });
      if (treeRes.ok) {
        const treeData = await treeRes.json() as { tree: Array<{ path: string; type: string; size?: number }> };
        repoFiles = treeData.tree.filter((t) => t.type === "blob").map((t) => t.path);

        scan.fileTree = treeData.tree
          .filter((t) => t.type === "blob")
          .slice(0, 200)
          .map((t): ScanResultFile => ({
            path: t.path,
            type: "file",
            size: t.size,
          }));
      }
    } catch {
      // File tree fetch failed — continue with empty
    }

    // Use LLM results if available, otherwise rule-based
    if (result) {
      scan.detectedPatterns = result.detectedPatterns;
      scan.gapAnalysis = result.gapAnalysis;
      scan.detectedAdapters = result.detectedAdapters;
      scan.analysisSource = "llm";
    } else {
      scan.detectedPatterns = buildPatterns(analysis, repoFiles);
      scan.gapAnalysis = buildGapAnalysis(analysis, repoFiles);
      scan.detectedAdapters = detectAdapters(repoFiles);
      scan.analysisSource = "rule-based";
    }

    // ── Phase 3: Generate .dev/ files ──
    scan.status = "generating";
    scan.updatedAt = new Date().toISOString();
    await saveScanResult(scan);

    if (result?.generatedFiles && result.generatedFiles.length > 0) {
      scan.generatedFiles = result.generatedFiles;
    } else {
      scan.generatedFiles = buildGeneratedFiles(project, analysis, scan.gapAnalysis, relevant, scan.detectedAdapters);
    }

    // ── Phase 4: Push .dev/ files to GitHub ──
    if (!skipPush) {
      try {
        await pushFiles(
          owner,
          repo,
          scan.generatedFiles.map((f) => ({ path: f.path, content: f.content })),
          "chore: generate .dev/ project intelligence folder"
        );
      } catch (pushErr) {
        console.error("Failed to push .dev/ files to repo:", pushErr);
        // Non-fatal — scan results are still saved locally
      }
    }

    // Mark done
    scan.status = "done";
    scan.updatedAt = new Date().toISOString();
    await saveScanResult(scan);

    // Update project devFolder
    await saveProject({
      ...project,
      devFolder: {
        status: "generated",
        lastScan: scan.updatedAt,
        scanResultId: scan.id,
        gapScore: {
          aligned: scan.gapAnalysis.filter((g) => g.status === "aligned").length,
          partial: scan.gapAnalysis.filter((g) => g.status === "partial").length,
          gap: scan.gapAnalysis.filter((g) => g.status === "gap").length,
        },
        adapters: scan.detectedAdapters,
      },
    });

    return json(scan);
  } catch (err) {
    console.error("generate-dev function error:", err);
    const { message, status } = classifyError(err, "Failed to generate .dev/ folder");
    return errorResponse(message, status);
  }
}
