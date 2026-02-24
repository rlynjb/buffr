import type { Context } from "@netlify/functions";
import { getLLM } from "./lib/ai/provider";
import { generateFileContent } from "./lib/ai/chains/file-generator";
import { createRepo, pushFiles, getRepoInfo, analyzeRepo, getIssues, getUserRepos } from "./lib/github";
import type { ScaffoldRequest, PlanFeature } from "../../src/lib/types";
import { json, errorResponse, classifyError } from "./lib/responses";

function parseOwnerRepo(raw: string): [string, string] | null {
  const ownerRepo = raw.replace(/\.git$/, "");
  const [owner, repo] = ownerRepo.split("/");
  if (!owner || !repo) return null;
  return [owner, repo];
}

// GET ?repos
async function handleRepos(): Promise<Response> {
  try {
    const repoList = await getUserRepos();
    return json(repoList);
  } catch (err) {
    const { message, status } = classifyError(err, "Failed to fetch repos");
    return errorResponse(message, status);
  }
}

// GET ?analyze=owner/repo
async function handleAnalyze(raw: string): Promise<Response> {
  try {
    const parsed = parseOwnerRepo(raw);
    if (!parsed) return errorResponse("Invalid owner/repo format", 400);
    const [owner, repo] = parsed;

    const info = await getRepoInfo(`${owner}/${repo}`);
    if (!info) return errorResponse("Repository not found", 404);

    const [analysis, issueList] = await Promise.all([
      analyzeRepo(owner, repo, info.defaultBranch),
      getIssues(owner, repo),
    ]);

    return json({ ...analysis, issues: issueList, issueCount: issueList.length });
  } catch (err) {
    const { message, status } = classifyError(err, "Failed to analyze repository");
    return errorResponse(message, status);
  }
}

// GET ?issues=owner/repo
async function handleIssues(raw: string): Promise<Response> {
  try {
    const parsed = parseOwnerRepo(raw);
    if (!parsed) return errorResponse("Invalid owner/repo format", 400);
    const [owner, repo] = parsed;

    const issueList = await getIssues(owner, repo);
    return json(issueList);
  } catch (err) {
    const { message, status } = classifyError(err, "Failed to fetch issues");
    return errorResponse(message, status);
  }
}

// GET ?validate=owner/repo
async function handleValidate(raw: string): Promise<Response> {
  try {
    const ownerRepo = raw.replace(/\.git$/, "");
    const info = await getRepoInfo(ownerRepo);
    if (!info) return errorResponse("Repository not found or not accessible", 404);
    return json(info);
  } catch (err) {
    const { message, status } = classifyError(err, "Failed to validate repository");
    return errorResponse(message, status);
  }
}

// POST — scaffold a new project
async function handleScaffold(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as ScaffoldRequest;

    // 1. Generate scaffold files
    const scaffoldFiles = generateScaffoldFiles(
      body.stack,
      body.projectName,
      body.features
    );

    // 2. Generate content for selected project files via LLM
    const llm = getLLM(body.provider || "anthropic");
    const featureNames = body.features
      .filter((f) => f.checked)
      .map((f) => f.name);

    const fileGenPromises = body.selectedFiles.map(async (fileType) => {
      const content = await generateFileContent(llm, {
        fileType,
        projectName: body.projectName,
        description: body.description,
        stack: body.stack,
        features: featureNames,
        constraints: body.constraints,
        goals: body.goals,
      });
      return { path: fileType, content };
    });

    const generatedFiles = await Promise.all(fileGenPromises);

    // 3. Combine all files
    const allFiles = [...scaffoldFiles, ...generatedFiles];

    // 4. Create GitHub repo
    const { owner, repo, url } = await createRepo(
      body.repoName,
      body.repoDescription,
      body.repoVisibility === "private"
    );

    // 5. Push all files
    await pushFiles(owner, repo, allFiles, "Initial commit from buffr");

    return json({
      repoUrl: url,
      githubRepo: `${owner}/${repo}`,
      files: allFiles.map((f) => f.path),
    });
  } catch (err: unknown) {
    console.error("scaffold function error:", err);
    const { message, status } = classifyError(err, "Failed to scaffold project");
    return errorResponse(message, status);
  }
}

function generateScaffoldFiles(
  stack: string,
  projectName: string,
  features: PlanFeature[]
): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];
  const isNextjs = stack.toLowerCase().includes("next");
  const isReact = stack.toLowerCase().includes("react") || isNextjs;
  const isTypescript = stack.toLowerCase().includes("typescript") || stack.toLowerCase().includes("ts");
  const ext = isTypescript ? "tsx" : "jsx";
  const extPlain = isTypescript ? "ts" : "js";

  // package.json
  const deps: Record<string, string> = {};
  const devDeps: Record<string, string> = {};

  if (isNextjs) {
    deps["next"] = "latest";
    deps["react"] = "^19.0.0";
    deps["react-dom"] = "^19.0.0";
    devDeps["@types/node"] = "^20";
    devDeps["@types/react"] = "^19";
    devDeps["typescript"] = "^5";
  }

  if (stack.toLowerCase().includes("tailwind")) {
    devDeps["tailwindcss"] = "^4";
    devDeps["@tailwindcss/postcss"] = "^4";
  }

  files.push({
    path: "package.json",
    content: JSON.stringify(
      {
        name: projectName,
        version: "0.1.0",
        private: true,
        scripts: {
          dev: isNextjs ? "next dev" : "echo \"Add dev script\"",
          build: isNextjs ? "next build" : "echo \"Add build script\"",
          start: isNextjs ? "next start" : "echo \"Add start script\"",
          lint: "eslint .",
        },
        dependencies: deps,
        devDependencies: devDeps,
      },
      null,
      2
    ),
  });

  if (isTypescript) {
    files.push({
      path: "tsconfig.json",
      content: JSON.stringify(
        {
          compilerOptions: {
            target: "ES2017",
            lib: ["dom", "dom.iterable", "esnext"],
            allowJs: true,
            skipLibCheck: true,
            strict: true,
            noEmit: true,
            esModuleInterop: true,
            module: "esnext",
            moduleResolution: "bundler",
            resolveJsonModule: true,
            isolatedModules: true,
            jsx: "react-jsx",
            incremental: true,
            paths: { "@/*": ["./src/*"] },
          },
          include: ["**/*.ts", "**/*.tsx"],
          exclude: ["node_modules"],
        },
        null,
        2
      ),
    });
  }

  if (isNextjs) {
    files.push({
      path: `next.config.${extPlain}`,
      content: `import type { NextConfig } from "next";\n\nconst nextConfig: NextConfig = {};\n\nexport default nextConfig;\n`,
    });

    if (stack.toLowerCase().includes("tailwind")) {
      files.push({
        path: "postcss.config.mjs",
        content: `const config = {\n  plugins: {\n    "@tailwindcss/postcss": {},\n  },\n};\n\nexport default config;\n`,
      });
    }

    files.push({
      path: `src/app/layout.${ext}`,
      content: `import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "${projectName}",
  description: "Generated by buffr",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
    });

    files.push({
      path: `src/app/page.${ext}`,
      content: `export default function Home() {
  return (
    <main>
      <h1>${projectName}</h1>
      <p>Welcome to your new project.</p>
    </main>
  );
}
`,
    });

    files.push({
      path: "src/app/globals.css",
      content: stack.toLowerCase().includes("tailwind")
        ? `@import "tailwindcss";\n`
        : `* { margin: 0; padding: 0; box-sizing: border-box; }\n`,
    });
  }

  for (const feature of features.filter((f) => f.checked && f.phase === 1)) {
    const slug = feature.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
    if (isNextjs || isReact) {
      files.push({
        path: `src/features/${slug}/index.${extPlain}`,
        content: `// TODO: Implement "${feature.name}"\n// ${feature.description}\n// Complexity: ${feature.complexity}\n\nexport {};\n`,
      });
    }
  }

  return files;
}

export default async function handler(req: Request, _context: Context) {
  if (req.method === "GET") {
    const url = new URL(req.url);
    const validate = url.searchParams.get("validate");
    const analyze = url.searchParams.get("analyze");
    const issues = url.searchParams.get("issues");
    const repos = url.searchParams.has("repos");

    if (repos) return handleRepos();
    if (analyze) return handleAnalyze(analyze);
    if (issues) return handleIssues(issues);
    if (validate) return handleValidate(validate);
    return errorResponse("Method not allowed", 405);
  }

  if (req.method === "POST") return handleScaffold(req);

  return errorResponse("Method not allowed", 405);
}
