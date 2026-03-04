import { getStore } from "@netlify/blobs";
import type { ScanResult } from "../../../../src/lib/types";

const STORE_NAME = "scan-results";

function store() {
  return getStore(STORE_NAME);
}

export async function getScanResult(id: string): Promise<ScanResult | null> {
  const s = store();
  const data = await s.get(id, { type: "text" });
  if (!data) return null;
  return JSON.parse(data) as ScanResult;
}

export async function listScanResultsByProject(
  projectId: string
): Promise<ScanResult[]> {
  const s = store();
  const { blobs } = await s.list();
  const results: ScanResult[] = [];
  for (const blob of blobs) {
    const data = await s.get(blob.key, { type: "text" });
    if (data) {
      const result = JSON.parse(data) as ScanResult;
      if (result.projectId === projectId) {
        results.push(result);
      }
    }
  }
  return results.sort(
    (a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

export async function saveScanResult(
  result: ScanResult
): Promise<ScanResult> {
  const s = store();
  await s.set(result.id, JSON.stringify(result));
  return result;
}

export async function deleteScanResult(id: string): Promise<void> {
  const s = store();
  await s.delete(id);
}
