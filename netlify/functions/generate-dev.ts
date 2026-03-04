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
  TechDebtItem,
  DetectedPattern,
  ScanResultFile,
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
    techDebtItems: [],
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

function buildTechDebt(analysis: RepoAnalysis, files: string[]): TechDebtItem[] {
  const items: TechDebtItem[] = [];

  if (!analysis.hasTests) {
    items.push({ type: "Missing tests", file: "package.json", severity: "high", text: "No test framework detected — project lacks automated tests" });
  }

  if (!analysis.hasCI) {
    items.push({ type: "No CI/CD", file: ".github/workflows/", severity: "high", text: "No CI pipeline detected — code changes are not automatically validated" });
  }

  const hasErrorBoundary = files.some((f) => f.includes("error.tsx") || f.includes("error.ts"));
  if (!hasErrorBoundary && (analysis.frameworks.includes("Next.js") || analysis.frameworks.includes("React"))) {
    items.push({ type: "No error boundary", file: "src/app/", severity: "medium", text: "No error.tsx files for route-level error handling" });
  }

  const hasLinter = analysis.devTools.some((t) => ["ESLint", "Prettier"].includes(t));
  if (!hasLinter) {
    items.push({ type: "No linter", file: "package.json", severity: "medium", text: "No ESLint or Prettier detected — code style is not enforced" });
  }

  const hasEnvExample = files.some((f) => f === ".env.example" || f === ".env.local.example");
  if (!hasEnvExample && files.some((f) => f === ".gitignore")) {
    items.push({ type: "No .env docs", file: ".env.example", severity: "low", text: "No .env.example file — environment variables are not documented" });
  }

  const hasReadme = files.some((f) => f.toLowerCase() === "readme.md");
  if (!hasReadme) {
    items.push({ type: "No README", file: "README.md", severity: "medium", text: "No README.md — project lacks documentation for new contributors" });
  }

  return items;
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
  techDebt: TechDebtItem[],
  standards: string
): { path: string; content: string; ownership: string }[] {
  const stackStr = analysis.detectedStack || project.stack || "Unknown";
  const devToolsStr = analysis.devTools.length > 0 ? analysis.devTools.join(", ") : "None detected";

  return [
    {
      path: ".dev/CONVENTIONS.md",
      ownership: "reviewable",
      content: [
        "# Coding Conventions",
        "",
        "## Detected Stack",
        `${stackStr}`,
        "",
        "## Dev Tools",
        `${devToolsStr}`,
        "",
        "## Guidelines",
        analysis.frameworks.includes("TypeScript") ? "- Use strict TypeScript — avoid `any`, prefer `unknown` for untyped values" : "",
        analysis.frameworks.includes("React") || analysis.frameworks.includes("Next.js") ? "- Prefer function components with hooks\n- Use named exports for components\n- Co-locate component files (tsx, css, test)" : "",
        analysis.frameworks.includes("Tailwind CSS") ? "- Use `@apply` in co-located CSS files with BEM naming\n- Use `@reference` for Tailwind class resolution" : "",
        analysis.frameworks.includes("Next.js") ? "- Use App Router patterns: layout.tsx, loading.tsx, error.tsx\n- Fetch data in Server Components when possible" : "",
        "",
      ].filter(Boolean).join("\n"),
    },
    {
      path: ".dev/ARCHITECTURE.md",
      ownership: "reviewable",
      content: [
        "# Architecture Overview",
        "",
        "## Stack",
        ...analysis.frameworks.map((f) => `- ${f}`),
        "",
        "## Project Phase",
        `Detected: **${analysis.detectedPhase}** (${analysis.fileCount} files)`,
        "",
        "## Signals",
        `- Tests: ${analysis.hasTests ? "Yes" : "No"}`,
        `- CI/CD: ${analysis.hasCI ? "Yes" : "No"}`,
        `- Deploy config: ${analysis.hasDeployConfig ? "Yes" : "No"}`,
        "",
      ].join("\n"),
    },
    {
      path: ".dev/STANDARDS.md",
      ownership: "system",
      content: standards || "# Industry Standards\n\nNo matching standards found. Seed the industry KB to populate this file.\n",
    },
    {
      path: ".dev/TECH_DEBT.md",
      ownership: "append-only",
      content: [
        "# Tech Debt Inventory",
        "",
        "## High Priority",
        ...techDebt.filter((d) => d.severity === "high").map((d) => `- [ ] ${d.text}`),
        "",
        "## Medium Priority",
        ...techDebt.filter((d) => d.severity === "medium").map((d) => `- [ ] ${d.text}`),
        "",
        "## Low Priority",
        ...techDebt.filter((d) => d.severity === "low").map((d) => `- [ ] ${d.text}`),
        "",
      ].join("\n"),
    },
    {
      path: ".dev/prompts/review.md",
      ownership: "user",
      content: [
        "# Code Review Prompt",
        "",
        `Review code changes for this ${stackStr} project:`,
        "",
        analysis.frameworks.includes("TypeScript") ? "1. Type safety and TypeScript best practices" : "1. Code quality and best practices",
        analysis.frameworks.includes("React") || analysis.frameworks.includes("Next.js") ? "2. Component structure and separation of concerns" : "2. Module structure and separation of concerns",
        analysis.frameworks.includes("Tailwind CSS") ? "3. CSS/styling consistency" : "3. Consistent styling approach",
        "4. Error handling completeness",
        "5. Accessibility considerations",
        "",
        "Flag any potential issues and suggest improvements.",
        "",
      ].join("\n"),
    },
    {
      path: ".dev/prompts/planning.md",
      ownership: "user",
      content: [
        "# Planning Prompt",
        "",
        "Given the current project state:",
        `- **Stack:** ${stackStr}`,
        `- **Phase:** ${project.phase}`,
        `- **Files:** ${analysis.fileCount}`,
        `- **Tests:** ${analysis.hasTests ? "Yes" : "No"}`,
        `- **CI:** ${analysis.hasCI ? "Yes" : "No"}`,
        "",
        "Help plan the next feature or improvement considering:",
        "1. Current tech debt and gaps",
        "2. Industry best practices for the stack",
        "3. Project goals and constraints",
        "",
      ].join("\n"),
    },
  ];
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
    const { projectId, provider } = body as {
      projectId: string;
      provider?: string;
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
      scan.techDebtItems = result.techDebtItems;
      scan.gapAnalysis = result.gapAnalysis;
      scan.detectedAdapters = result.detectedAdapters;
      scan.analysisSource = "llm";
    } else {
      scan.detectedPatterns = buildPatterns(analysis, repoFiles);
      scan.techDebtItems = buildTechDebt(analysis, repoFiles);
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
      scan.generatedFiles = buildGeneratedFiles(project, analysis, scan.techDebtItems, standardsText);
    }

    // ── Phase 4: Push .dev/ files to GitHub ──
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
