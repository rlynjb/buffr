import type { Context } from "@netlify/functions";
import { randomUUID } from "crypto";
import { getProject, saveProject } from "./lib/storage/projects";
import { saveScanResult } from "./lib/storage/scan-results";
import { detectExistingDevFolder } from "./lib/github";
import { json, errorResponse } from "./lib/responses";
import type { ScanResult } from "../../src/lib/types";

/**
 * POST /detect-dev
 * Checks if a repo already has a .dev/ folder and imports it.
 * Body: { projectId: string }
 * Returns the imported ScanResult, or { detected: false }.
 */
export default async function handler(req: Request, _context: Context) {
  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  try {
    const { projectId } = await req.json();
    if (!projectId) return errorResponse("projectId required", 400);

    const project = await getProject(projectId);
    if (!project) return errorResponse("Project not found", 404);
    if (!project.githubRepo) return json({ detected: false });

    // Already has a devFolder — skip detection
    if (project.devFolder) return json({ detected: false });

    const devFiles = await detectExistingDevFolder(project.githubRepo);
    if (!devFiles || devFiles.length === 0) {
      return json({ detected: false });
    }

    const now = new Date().toISOString();
    const scanId = randomUUID();
    const scan: ScanResult = {
      id: scanId,
      projectId: project.id,
      repoFullName: project.githubRepo,
      status: "done",
      detectedStack: [],
      detectedPatterns: [],
      techDebtItems: [],
      gapAnalysis: [],
      parsedConfigs: [],
      gitActivity: { recentCommits: 0, activePaths: [], lastCommitDate: "" },
      generatedFiles: devFiles.map((f) => ({
        path: f.path,
        content: f.content,
        ownership: "imported",
      })),
      fileTree: [],
      detectedAdapters: devFiles
        .filter((f) => f.path.startsWith(".dev/adapters/"))
        .map((f) => f.path.replace(".dev/adapters/", "").replace(/\.\w+$/, "")),
      analysisSource: "imported",
      error: null,
      createdAt: now,
      updatedAt: now,
    };

    await saveScanResult(scan);
    await saveProject({
      ...project,
      devFolder: {
        status: "generated",
        lastScan: now,
        scanResultId: scanId,
        gapScore: null,
        adapters: scan.detectedAdapters,
      },
    });

    return json(scan);
  } catch (err) {
    console.error("detect-dev function error:", err);
    return errorResponse("Internal server error", 500);
  }
}
