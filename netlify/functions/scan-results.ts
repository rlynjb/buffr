import type { Context } from "@netlify/functions";
import {
  getScanResult,
  listScanResultsByProject,
  deleteScanResult,
} from "./lib/storage/scan-results";
import { json, errorResponse } from "./lib/responses";

export default async function handler(req: Request, _context: Context) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const projectId = url.searchParams.get("projectId");

  try {
    if (req.method === "GET") {
      if (id) {
        const result = await getScanResult(id);
        if (!result) {
          return errorResponse("Scan result not found", 404);
        }
        return json(result);
      }
      if (projectId) {
        const results = await listScanResultsByProject(projectId);
        return json(results);
      }
      return errorResponse("id or projectId query param required", 400);
    }

    if (req.method === "DELETE") {
      if (!id) {
        return errorResponse("Scan result id required", 400);
      }
      await deleteScanResult(id);
      return json({ ok: true });
    }

    return errorResponse("Method not allowed", 405);
  } catch (err) {
    console.error("scan-results function error:", err);
    return errorResponse("Internal server error", 500);
  }
}
