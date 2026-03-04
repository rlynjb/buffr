import { getStore } from "@netlify/blobs";
import type { IndustryStandard, IndustryKBMeta } from "../../../../src/lib/types";

const STORE_NAME = "industry-kb";
const META_STORE_NAME = "industry-kb-meta";

function store() {
  return getStore(STORE_NAME);
}

function metaStore() {
  return getStore(META_STORE_NAME);
}

// Industry standards

export async function getStandard(
  technology: string
): Promise<IndustryStandard | null> {
  const s = store();
  const data = await s.get(technology, { type: "text" });
  if (!data) return null;
  return JSON.parse(data) as IndustryStandard;
}

export async function listStandards(): Promise<IndustryStandard[]> {
  const s = store();
  const { blobs } = await s.list();
  const standards: IndustryStandard[] = [];
  for (const blob of blobs) {
    const data = await s.get(blob.key, { type: "text" });
    if (data) {
      standards.push(JSON.parse(data) as IndustryStandard);
    }
  }
  return standards.sort((a, b) => a.technology.localeCompare(b.technology));
}

export async function saveStandard(
  standard: IndustryStandard
): Promise<IndustryStandard> {
  const s = store();
  await s.set(standard.technology, JSON.stringify(standard));
  return standard;
}

export async function deleteStandard(technology: string): Promise<void> {
  const s = store();
  await s.delete(technology);
}

// KB metadata

export async function getMeta(
  technology: string
): Promise<IndustryKBMeta | null> {
  const s = metaStore();
  const data = await s.get(technology, { type: "text" });
  if (!data) return null;
  return JSON.parse(data) as IndustryKBMeta;
}

export async function listMeta(): Promise<IndustryKBMeta[]> {
  const s = metaStore();
  const { blobs } = await s.list();
  const metas: IndustryKBMeta[] = [];
  for (const blob of blobs) {
    const data = await s.get(blob.key, { type: "text" });
    if (data) {
      metas.push(JSON.parse(data) as IndustryKBMeta);
    }
  }
  return metas;
}

export async function saveMeta(
  meta: IndustryKBMeta
): Promise<IndustryKBMeta> {
  const s = metaStore();
  await s.set(meta.technology, JSON.stringify(meta));
  return meta;
}
