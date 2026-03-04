import type { Context } from "@netlify/functions";
import { getStandard, listStandards } from "./lib/storage/industry-kb";
import { seedIndustryKB } from "./lib/industry-kb/seed";
import { json, errorResponse } from "./lib/responses";

export default async function handler(req: Request, _context: Context) {
  const url = new URL(req.url);
  const technology = url.searchParams.get("technology");

  try {
    if (req.method === "GET") {
      if (technology) {
        const standard = await getStandard(technology);
        if (!standard) {
          return errorResponse("Standard not found", 404);
        }
        return json(standard);
      }
      const standards = await listStandards();
      return json(standards);
    }

    if (req.method === "POST" && url.searchParams.has("seed")) {
      const body = req.headers.get("content-type")?.includes("json")
        ? await req.json()
        : {};
      const force = Boolean(body.force);
      const result = await seedIndustryKB(force);
      return json(result);
    }

    return errorResponse("Method not allowed", 405);
  } catch (err) {
    console.error("industry-kb function error:", err);
    return errorResponse("Internal server error", 500);
  }
}
