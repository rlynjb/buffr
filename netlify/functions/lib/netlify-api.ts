import { createHash } from "crypto";

const NETLIFY_API_BASE = "https://api.netlify.com/api/v1";

function getToken(): string {
  const token = process.env.NETLIFY_TOKEN;
  if (!token) throw new Error("NETLIFY_TOKEN not configured. Add NETLIFY_TOKEN to your .env file.");
  return token;
}

async function netlifyFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const res = await fetch(`${NETLIFY_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Netlify API error (${res.status}): ${text}`);
  }
  return res;
}

function sha1(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

export async function createSite(
  name: string,
  githubRepo: string
): Promise<{ siteId: string; siteUrl: string }> {
  const suffix = crypto.randomUUID().substring(0, 6);
  const siteName = `${name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}-${suffix}`;

  const res = await netlifyFetch("/sites", {
    method: "POST",
    body: JSON.stringify({
      name: siteName,
    }),
  });
  const data = await res.json();
  const siteId = data.id as string;
  const siteUrl = (data.ssl_url || data.url || `https://${siteName}.netlify.app`) as string;

  // Deploy a placeholder page so the site isn't empty
  await deployPlaceholder(siteId, name, githubRepo);

  return { siteId, siteUrl };
}

async function deployPlaceholder(
  siteId: string,
  projectName: string,
  githubRepo: string
): Promise<void> {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${projectName}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; background: #0a0a0a; color: #e5e5e5; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .container { text-align: center; max-width: 480px; padding: 2rem; }
    h1 { font-size: 2rem; margin-bottom: 0.5rem; }
    p { color: #888; margin-bottom: 1.5rem; font-size: 0.9rem; }
    a { color: #3b82f6; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .steps { text-align: left; background: #111; border: 1px solid #222; border-radius: 8px; padding: 1.5rem; font-size: 0.85rem; }
    .steps li { margin-bottom: 0.5rem; color: #aaa; }
    .steps code { background: #1a1a1a; padding: 2px 6px; border-radius: 4px; font-size: 0.8rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>${projectName}</h1>
    <p>Scaffolded by <strong>buffr</strong></p>
    <div class="steps">
      <p style="color:#e5e5e5;margin-bottom:1rem;">Next steps:</p>
      <ol>
        <li>Clone: <code>git clone https://github.com/${githubRepo}</code></li>
        <li>Install: <code>npm install</code></li>
        <li>Run: <code>npm run dev</code></li>
        <li><a href="https://app.netlify.com" target="_blank">Link repo in Netlify dashboard</a> to enable builds</li>
      </ol>
    </div>
  </div>
</body>
</html>`;

  const hash = sha1(html);

  // Create deploy with file manifest
  const deployRes = await netlifyFetch(`/sites/${siteId}/deploys`, {
    method: "POST",
    body: JSON.stringify({
      files: { "/index.html": hash },
    }),
  });
  const deploy = await deployRes.json();
  const deployId = deploy.id as string;

  // Upload the file
  const token = getToken();
  const uploadRes = await fetch(
    `${NETLIFY_API_BASE}/deploys/${deployId}/files/index.html`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
      },
      body: html,
    }
  );
  if (!uploadRes.ok) {
    const text = await uploadRes.text();
    throw new Error(`Netlify file upload error (${uploadRes.status}): ${text}`);
  }
}
