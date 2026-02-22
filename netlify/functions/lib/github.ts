const API = "https://api.github.com";

function getToken(): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN not configured. Add GITHUB_TOKEN to your .env file.");
  return token;
}

async function gh(path: string, options: RequestInit = {}): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};

  if (!res.ok) {
    const d = data as Record<string, unknown>;
    let msg = String(d.message || `GitHub API error (${res.status})`);
    if (Array.isArray(d.errors)) {
      const details = (d.errors as Array<Record<string, unknown>>)
        .map((e) => e.message || JSON.stringify(e))
        .join(", ");
      msg += `: ${details}`;
    }
    throw new Error(msg);
  }

  return data as Record<string, unknown>;
}

async function ghList(path: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${getToken()}`,
      Accept: "application/vnd.github+json",
    },
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : [];

  if (!res.ok) {
    const d = Array.isArray(data) ? {} : (data as Record<string, unknown>);
    throw new Error(String(d.message || `GitHub API error (${res.status})`));
  }

  return data as Array<Record<string, unknown>>;
}

export async function createRepo(
  name: string,
  description: string,
  isPrivate: boolean
): Promise<{ owner: string; repo: string; url: string }> {
  const data = await gh("/user/repos", {
    method: "POST",
    body: JSON.stringify({ name, description, private: isPrivate, auto_init: true }),
  });
  const owner = (data.owner as Record<string, unknown>).login as string;
  return {
    owner,
    repo: data.name as string,
    url: data.html_url as string,
  };
}

export async function pushFiles(
  owner: string,
  repo: string,
  files: Array<{ path: string; content: string }>,
  message: string
): Promise<string> {
  // Get the current HEAD commit to use as parent
  const ref = await gh(`/repos/${owner}/${repo}/git/ref/heads/main`);
  const headSha = (ref.object as Record<string, unknown>).sha as string;
  const headCommit = await gh(`/repos/${owner}/${repo}/git/commits/${headSha}`);
  const baseTreeSha = headCommit.tree as Record<string, unknown>;

  // Create blobs for each file
  const blobs = await Promise.all(
    files.map(async (file) => {
      const data = await gh(`/repos/${owner}/${repo}/git/blobs`, {
        method: "POST",
        body: JSON.stringify({
          content: Buffer.from(file.content).toString("base64"),
          encoding: "base64",
        }),
      });
      return { path: file.path, sha: data.sha as string, mode: "100644", type: "blob" };
    })
  );

  // Create tree with base_tree so it layers on top of the init commit
  const tree = await gh(`/repos/${owner}/${repo}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: baseTreeSha.sha as string, tree: blobs }),
  });

  // Create commit with parent
  const commit = await gh(`/repos/${owner}/${repo}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message, tree: tree.sha as string, parents: [headSha] }),
  });

  // Update main branch ref
  await gh(`/repos/${owner}/${repo}/git/refs/heads/main`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha as string }),
  });

  return commit.sha as string;
}

export async function getRepoInfo(ownerRepo: string): Promise<{
  name: string;
  description: string | null;
  defaultBranch: string;
  lastCommit: string;
} | null> {
  const [owner, repo] = ownerRepo.split("/");
  if (!owner || !repo) return null;

  try {
    const data = await gh(`/repos/${owner}/${repo}`);
    let lastCommit = "";
    try {
      const commits = await gh(`/repos/${owner}/${repo}/commits?per_page=1`);
      if (Array.isArray(commits) && commits.length > 0) {
        lastCommit = (commits[0].sha as string).substring(0, 7);
      }
    } catch {
      // no commits yet
    }
    return {
      name: data.name as string,
      description: (data.description as string | null),
      defaultBranch: data.default_branch as string,
      lastCommit,
    };
  } catch {
    return null;
  }
}

export async function getRepoFiles(
  owner: string,
  repo: string,
  branch: string
): Promise<string[]> {
  try {
    const data = await gh(`/repos/${owner}/${repo}/git/trees/${branch}?recursive=true`);
    const tree = data.tree as Array<Record<string, unknown>>;
    return tree
      .filter((item) => item.type === "blob")
      .map((item) => item.path as string);
  } catch {
    return [];
  }
}

export async function getFileContent(
  owner: string,
  repo: string,
  path: string
): Promise<string | null> {
  try {
    const data = await gh(`/repos/${owner}/${repo}/contents/${path}`);
    if ("content" in data && data.encoding === "base64") {
      return Buffer.from(data.content as string, "base64").toString("utf-8");
    }
    return null;
  } catch {
    return null;
  }
}

export async function getIssues(
  owner: string,
  repo: string,
  limit: number = 10
): Promise<Array<{
  number: number;
  title: string;
  url: string;
  labels: string[];
  createdAt: string;
}>> {
  try {
    const items = await ghList(
      `/repos/${owner}/${repo}/issues?state=open&per_page=${limit}&sort=updated&direction=desc`
    );
    return items
      .filter((item) => !item.pull_request)
      .map((item) => ({
        number: item.number as number,
        title: item.title as string,
        url: item.html_url as string,
        labels: Array.isArray(item.labels)
          ? (item.labels as Array<Record<string, unknown>>).map(
              (l) => (l.name as string) || ""
            )
          : [],
        createdAt: item.created_at as string,
      }));
  } catch {
    return [];
  }
}

export async function analyzeRepo(
  owner: string,
  repo: string,
  branch: string
): Promise<{
  detectedStack: string;
  frameworks: string[];
  devTools: string[];
  hasTests: boolean;
  hasCI: boolean;
  hasDeployConfig: boolean;
  fileCount: number;
  detectedPhase: "idea" | "mvp" | "polish" | "deploy";
}> {
  const files = await getRepoFiles(owner, repo, branch);
  const fileCount = files.length;

  // Read package.json if it exists
  let pkgDeps: Record<string, string> = {};
  if (files.includes("package.json")) {
    const content = await getFileContent(owner, repo, "package.json");
    if (content) {
      try {
        const pkg = JSON.parse(content) as Record<string, unknown>;
        pkgDeps = {
          ...((pkg.dependencies as Record<string, string>) || {}),
          ...((pkg.devDependencies as Record<string, string>) || {}),
        };
      } catch {
        // invalid package.json
      }
    }
  }

  // Detect frameworks
  const frameworks: string[] = [];
  const frameworkMap: Record<string, string> = {
    next: "Next.js",
    react: "React",
    vue: "Vue",
    nuxt: "Nuxt",
    svelte: "Svelte",
    "@sveltejs/kit": "SvelteKit",
    "@angular/core": "Angular",
    express: "Express",
    fastify: "Fastify",
    hono: "Hono",
    astro: "Astro",
    gatsby: "Gatsby",
    "@remix-run/react": "Remix",
    "solid-js": "Solid",
  };
  for (const [dep, label] of Object.entries(frameworkMap)) {
    if (dep in pkgDeps) frameworks.push(label);
  }

  if ("typescript" in pkgDeps || files.some((f) => f.endsWith(".ts") || f.endsWith(".tsx"))) {
    frameworks.push("TypeScript");
  }
  if ("tailwindcss" in pkgDeps) frameworks.push("Tailwind CSS");
  if ("styled-components" in pkgDeps) frameworks.push("styled-components");
  if ("@emotion/react" in pkgDeps) frameworks.push("Emotion");

  // Detect dev tools
  const devTools: string[] = [];
  const toolMap: Record<string, string> = {
    eslint: "ESLint",
    prettier: "Prettier",
    jest: "Jest",
    vitest: "Vitest",
    mocha: "Mocha",
    "@testing-library/react": "Testing Library",
    cypress: "Cypress",
    "@playwright/test": "Playwright",
    "@storybook/react": "Storybook",
    husky: "Husky",
    "lint-staged": "lint-staged",
  };
  for (const [dep, label] of Object.entries(toolMap)) {
    if (dep in pkgDeps) devTools.push(label);
  }

  // Maturity signals
  const hasTests = devTools.some((t) =>
    ["Jest", "Vitest", "Mocha", "Cypress", "Playwright", "Testing Library"].includes(t)
  ) || files.some((f) =>
    f.includes(".test.") || f.includes(".spec.") || f.includes("__tests__")
  );

  const hasCI = files.some((f) =>
    f.startsWith(".github/workflows/") ||
    f === ".gitlab-ci.yml" ||
    f === ".circleci/config.yml" ||
    f === "Jenkinsfile"
  );

  const hasDeployConfig = files.some((f) =>
    f === "netlify.toml" ||
    f === "vercel.json" ||
    f === "fly.toml" ||
    f === "Dockerfile" ||
    f === "docker-compose.yml" ||
    f === "render.yaml"
  );

  // Determine phase
  let detectedPhase: "idea" | "mvp" | "polish" | "deploy" = "mvp";
  if (fileCount < 5) {
    detectedPhase = "idea";
  } else if (hasDeployConfig && hasCI && hasTests) {
    detectedPhase = "deploy";
  } else if (hasTests && (hasCI || hasDeployConfig)) {
    detectedPhase = "polish";
  }

  // Build stack string — deduplicate (Next.js implies React, etc.)
  const stackFrameworks = [...frameworks];
  if (stackFrameworks.includes("Next.js")) {
    const i = stackFrameworks.indexOf("React");
    if (i !== -1) stackFrameworks.splice(i, 1);
  }
  if (stackFrameworks.includes("Nuxt")) {
    const i = stackFrameworks.indexOf("Vue");
    if (i !== -1) stackFrameworks.splice(i, 1);
  }
  if (stackFrameworks.includes("SvelteKit")) {
    const i = stackFrameworks.indexOf("Svelte");
    if (i !== -1) stackFrameworks.splice(i, 1);
  }

  return {
    detectedStack: stackFrameworks.join(" + ") || "Unknown stack",
    frameworks,
    devTools,
    hasTests,
    hasCI,
    hasDeployConfig,
    fileCount,
    detectedPhase,
  };
}
