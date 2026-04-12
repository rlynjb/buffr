/**
 * Migrate Netlify Blobs from old store names to new ones.
 *
 * - Copies all `dev-items` blobs → `buffr-global` store
 *   - Adds `category: "rules"` default to migrated entries
 * - Copies all `doc-items` blobs → `buffr-specs` store
 *   - Adds `status: "draft"` default to migrated entries
 *   - Maps old categories: docs → features, ideas → features, plans → phases
 *
 * Idempotent — safe to run multiple times.
 *
 * Usage: npx ts-node scripts/migrate-blobs.ts
 */

import { getStore } from "@netlify/blobs";

const OLD_CATEGORY_MAP: Record<string, string> = {
  docs: "features",
  ideas: "features",
  plans: "phases",
};

async function migrateDevItems() {
  const oldStore = getStore("dev-items");
  const newStore = getStore("buffr-global");
  const { blobs } = await oldStore.list();
  let count = 0;

  for (const blob of blobs) {
    const data = await oldStore.get(blob.key, { type: "text" });
    if (!data) continue;

    const item = JSON.parse(data);
    // Add category default if missing
    if (!item.category) {
      item.category = "rules";
    }
    // Update path prefix
    if (item.path?.startsWith(".dev/")) {
      item.path = item.path.replace(/^\.dev\//, ".buffr/global/");
    }

    await newStore.set(blob.key, JSON.stringify(item));
    count++;
  }

  console.log(`[migrate-blobs] dev-items → buffr-global: ${count} entries copied`);
}

async function migrateDocItems() {
  const oldStore = getStore("doc-items");
  const newStore = getStore("buffr-specs");
  const { blobs } = await oldStore.list();
  let count = 0;

  for (const blob of blobs) {
    const data = await oldStore.get(blob.key, { type: "text" });
    if (!data) continue;

    const item = JSON.parse(data);
    // Add status default if missing
    if (!item.status) {
      item.status = "draft";
    }
    // Map old categories to new ones
    if (item.category && OLD_CATEGORY_MAP[item.category]) {
      item.category = OLD_CATEGORY_MAP[item.category];
    }
    // Update path prefix
    if (item.path?.startsWith(".doc/")) {
      item.path = item.path.replace(/^\.doc\//, ".buffr/specs/");
    }

    await newStore.set(blob.key, JSON.stringify(item));
    count++;
  }

  console.log(`[migrate-blobs] doc-items → buffr-specs: ${count} entries copied`);
}

async function main() {
  console.log("[migrate-blobs] Starting migration...");
  await migrateDevItems();
  await migrateDocItems();
  console.log("[migrate-blobs] Migration complete.");
}

main().catch((err) => {
  console.error("[migrate-blobs] Migration failed:", err);
  process.exit(1);
});
