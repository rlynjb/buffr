import type { Context } from "@netlify/functions";
import { createSite } from "./lib/netlify-api";
import type { DeployRequest } from "../../src/lib/types";

export default async function handler(req: Request, _context: Context) {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const body = (await req.json()) as DeployRequest;

    if (!body.githubRepo) {
      return new Response(
        JSON.stringify({ error: "githubRepo is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Create Netlify site (without repo linking — user connects via dashboard)
    const { siteId, siteUrl } = await createSite(
      body.projectName,
      body.githubRepo
    );

    return new Response(
      JSON.stringify({ siteId, siteUrl, buildId: "pending" }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err: unknown) {
    console.error("deploy function error:", err);

    let message = "Failed to deploy";
    let status = 500;

    if (err instanceof Error) {
      const msg = err.message;
      if (msg.includes("NETLIFY_TOKEN") || msg.includes("not configured")) {
        message = msg;
        status = 400;
      } else if (msg.includes("subdomain") || msg.includes("must be unique")) {
        message = "Netlify site name conflict. Please retry.";
        status = 422;
      } else {
        message = msg;
      }
    }

    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
