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
  inputFiles: Array<{ path: string; content: string; mode?: string }>,
  message: string,
  deletePaths?: string[],
  branch?: string,
): Promise<string> {
  const targetBranch = branch || "main";
  let files = inputFiles;

  // Check if repo has commits
  let headSha: string | null = null;
  let baseTreeSha: string | null = null;
  try {
    const ref = await gh(`/repos/${owner}/${repo}/git/ref/heads/${targetBranch}`);
    headSha = (ref.object as Record<string, unknown>).sha as string;
    const headCommit = await gh(`/repos/${owner}/${repo}/git/commits/${headSha}`);
    baseTreeSha = (headCommit.tree as Record<string, unknown>).sha as string;
  } catch {
    // Empty repo — no existing commits
  }

  // Empty repo: Git Data API won't work. Bootstrap with Contents API, then proceed.
  if (!headSha) {
    const initFile = files[0];
    const initRes = await gh(`/repos/${owner}/${repo}/contents/${initFile.path}`, {
      method: "PUT",
      body: JSON.stringify({
        message,
        content: Buffer.from(initFile.content).toString("base64"),
        branch: targetBranch,
      }),
    });
    // If only one file, we're done
    if (files.length === 1) {
      return (initRes.commit as Record<string, unknown>).sha as string;
    }
    // Re-fetch HEAD now that repo is initialized
    const ref = await gh(`/repos/${owner}/${repo}/git/ref/heads/${targetBranch}`);
    headSha = (ref.object as Record<string, unknown>).sha as string;
    const headCommit = await gh(`/repos/${owner}/${repo}/git/commits/${headSha}`);
    baseTreeSha = (headCommit.tree as Record<string, unknown>).sha as string;
    // Remove the first file since it's already committed
    files = files.slice(1);
  }

  // Create blobs for each file
  const blobs = await Promise.all(
    files.map(async (file) => {
      const isSymlink = file.mode === "120000";
      const data = await gh(`/repos/${owner}/${repo}/git/blobs`, {
        method: "POST",
        body: JSON.stringify(
          isSymlink
            ? { content: file.content, encoding: "utf-8" }
            : { content: Buffer.from(file.content).toString("base64"), encoding: "base64" },
        ),
      });
      return { path: file.path, sha: data.sha as string, mode: file.mode || "100644", type: "blob" as const };
    })
  );

  // Add deletion entries (sha: null removes the file from the tree)
  const deleteEntries = (deletePaths || []).map((path) => ({
    path,
    sha: null,
    mode: "100644" as const,
    type: "blob" as const,
  }));

  // Create tree on top of existing base
  const tree = await gh(`/repos/${owner}/${repo}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: baseTreeSha, tree: [...blobs, ...deleteEntries] }),
  });

  // Create commit with parent
  const commit = await gh(`/repos/${owner}/${repo}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message, tree: tree.sha as string, parents: [headSha] }),
  });

  // Update branch ref
  await gh(`/repos/${owner}/${repo}/git/refs/heads/${targetBranch}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha as string }),
  });

  return commit.sha as string;
}

export async function getRepoInfo(ownerRepo: string): Promise<{
  name: string;
  fullName: string;
  description: string | null;
  defaultBranch: string;
  lastCommit: string;
} | null> {
  const [owner, repo] = ownerRepo.split("/");
  if (!owner || !repo) return null;

  try {
    const data = await gh(`/repos/${owner}/${repo}`);
    const fullName = (data.full_name as string) || `${owner}/${repo}`;
    let lastCommit = "";
    try {
      const commits = await gh(`/repos/${fullName}/commits?per_page=1`);
      if (Array.isArray(commits) && commits.length > 0) {
        lastCommit = (commits[0].sha as string).substring(0, 7);
      }
    } catch {
      // no commits yet
    }
    return {
      name: data.name as string,
      fullName,
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
  path: string,
  branch?: string,
): Promise<string | null> {
  try {
    let url = `/repos/${owner}/${repo}/contents/${path}`;
    if (branch) url += `?ref=${encodeURIComponent(branch)}`;
    const data = await gh(url);
    if ("content" in data && data.encoding === "base64") {
      return Buffer.from(data.content as string, "base64").toString("utf-8");
    }
    return null;
  } catch {
    return null;
  }
}

export async function listIssues(
  owner: string,
  repo: string,
  limit: number = 10,
  state: "open" | "closed" | "all" = "open"
): Promise<Array<{
  number: number;
  title: string;
  url: string;
  labels: string[];
  createdAt: string;
}>> {
  try {
    const items = await ghList(
      `/repos/${owner}/${repo}/issues?state=${state}&per_page=${limit}&sort=updated&direction=desc`
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

export async function getUserRepos(maxPages = 10): Promise<string[]> {
  try {
    const repos: string[] = [];
    let page = 1;
    while (page <= maxPages) {
      const items = await ghList(`/user/repos?per_page=100&page=${page}&sort=updated`);
      if (items.length === 0) break;
      for (const item of items) {
        repos.push(item.full_name as string);
      }
      if (items.length < 100) break;
      page++;
    }
    return repos;
  } catch {
    return [];
  }
}

export async function createIssue(
  owner: string,
  repo: string,
  title: string,
  body?: string,
  labels?: string[],
): Promise<{ number: number; url: string }> {
  const data = await gh(`/repos/${owner}/${repo}/issues`, {
    method: "POST",
    body: JSON.stringify({
      title,
      body: body || "",
      labels: labels || [],
    }),
  });
  return {
    number: data.number as number,
    url: data.html_url as string,
  };
}

export async function closeIssue(
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<void> {
  await gh(`/repos/${owner}/${repo}/issues/${issueNumber}`, {
    method: "PATCH",
    body: JSON.stringify({ state: "closed" }),
  });
}

export async function listCommits(
  owner: string,
  repo: string,
  since?: string,
  limit: number = 30,
): Promise<Array<{
  sha: string;
  message: string;
  author: string;
  date: string;
  files?: string[];
}>> {
  try {
    let path = `/repos/${owner}/${repo}/commits?per_page=${limit}`;
    if (since) path += `&since=${encodeURIComponent(since)}`;
    const items = await ghList(path);
    return items.map((item) => {
      const commit = item.commit as Record<string, unknown>;
      const authorObj = commit.author as Record<string, unknown>;
      return {
        sha: (item.sha as string).substring(0, 7),
        message: (commit.message as string).split("\n")[0],
        author: (authorObj.name as string) || "unknown",
        date: authorObj.date as string,
      };
    });
  } catch {
    return [];
  }
}

export async function listDiffs(
  owner: string,
  repo: string,
  base: string,
  head: string = "HEAD",
): Promise<{
  files: Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
  }>;
}> {
  try {
    const data = await gh(`/repos/${owner}/${repo}/compare/${base}...${head}`);
    const files = (data.files as Array<Record<string, unknown>>) || [];
    return {
      files: files.slice(0, 50).map((f) => ({
        filename: f.filename as string,
        status: f.status as string,
        additions: (f.additions as number) || 0,
        deletions: (f.deletions as number) || 0,
        patch: f.patch ? String(f.patch).substring(0, 500) : undefined,
      })),
    };
  } catch {
    return { files: [] };
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

