import type { Context } from "@netlify/functions";
import { createSite } from "./lib/netlify-api";
import type { DeployRequest } from "../../src/lib/types";
import { json, errorResponse, classifyError } from "./lib/responses";

export default async function handler(req: Request, _context: Context) {
  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  try {
    const body = (await req.json()) as DeployRequest;

    if (!body.githubRepo) {
      return errorResponse("githubRepo is required", 400);
    }

    // Create Netlify site (without repo linking — user connects via dashboard)
    const { siteId, siteUrl } = await createSite(
      body.projectName,
      body.githubRepo
    );

    return json({ siteId, siteUrl, buildId: "pending" });
  } catch (err: unknown) {
    console.error("deploy function error:", err);
    const { message, status } = classifyError(err, "Failed to deploy");
    return errorResponse(message, status);
  }
}
