/**
 * Backfill Postgres from Netlify Blobs.
 *
 * Reads every key from each Blob store and upserts into Postgres.
 * Idempotent — safe to run multiple times.
 *
 * Usage:
 *   NETLIFY_DATABASE_URL=... npx tsx scripts/backfill-postgres.ts
 */

import { getStore } from "@netlify/blobs";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import * as schema from "../netlify/functions/lib/db/schema";

const client = postgres(process.env.NETLIFY_DATABASE_URL!);
const db = drizzle(client);

const SITE_ID = process.env.NETLIFY_SITE_ID || "f03e28e3-8573-4e05-81d0-1d35022df372";
const TOKEN = process.env.NETLIFY_TOKEN!;

async function readAllBlobs(storeName: string): Promise<Array<{ key: string; data: string }>> {
  const s = getStore({ name: storeName, siteID: SITE_ID, token: TOKEN });
  const { blobs } = await s.list();
  const results: Array<{ key: string; data: string }> = [];
  for (const blob of blobs) {
    const data = await s.get(blob.key, { type: "text" });
    if (data) results.push({ key: blob.key, data });
  }
  return results;
}

async function backfillProjects() {
  const blobs = await readAllBlobs("projects");
  for (const { data } of blobs) {
    const p = JSON.parse(data);
    await db.insert(schema.projects).values({
      id: p.id,
      name: p.name,
      description: p.description || "",
      stack: p.stack || "",
      phase: p.phase,
      githubRepo: p.githubRepo,
      netlifySiteUrl: p.netlifySiteUrl,
      dataSources: p.dataSources || [],
      dismissedSuggestions: p.dismissedSuggestions || [],
      lastSessionId: p.lastSessionId,
      lastSyncedAt: p.lastSyncedAt ? new Date(p.lastSyncedAt) : null,
      updatedAt: new Date(p.updatedAt),
    }).onConflictDoUpdate({
      target: schema.projects.id,
      set: {
        name: p.name,
        description: p.description || "",
        stack: p.stack || "",
        phase: p.phase,
        githubRepo: p.githubRepo,
        netlifySiteUrl: p.netlifySiteUrl,
        dataSources: p.dataSources || [],
        dismissedSuggestions: p.dismissedSuggestions || [],
        lastSessionId: p.lastSessionId,
        lastSyncedAt: p.lastSyncedAt ? new Date(p.lastSyncedAt) : null,
        updatedAt: new Date(p.updatedAt),
      },
    });
  }
  console.log(`[backfill] projects: ${blobs.length} entries`);
}

async function backfillSessions() {
  const blobs = await readAllBlobs("sessions");
  // Get valid project IDs to skip orphaned sessions
  const projectRows = await db.select({ id: schema.projects.id }).from(schema.projects);
  const validProjectIds = new Set(projectRows.map((r) => r.id));
  let skipped = 0;
  for (const { data } of blobs) {
    const s = JSON.parse(data);
    if (!validProjectIds.has(s.projectId)) { skipped++; continue; }
    await db.insert(schema.sessions).values({
      id: s.id,
      projectId: s.projectId,
      goal: s.goal,
      whatChanged: s.whatChanged || [],
      blockers: s.blockers,
      detectedIntent: s.detectedIntent,
      createdAt: new Date(s.createdAt),
    }).onConflictDoUpdate({
      target: schema.sessions.id,
      set: {
        goal: s.goal,
        whatChanged: s.whatChanged || [],
        blockers: s.blockers,
        detectedIntent: s.detectedIntent,
      },
    });
  }
  console.log(`[backfill] sessions: ${blobs.length - skipped} entries (${skipped} orphaned, skipped)`);
}

async function backfillManualActions() {
  const blobs = await readAllBlobs("manual-actions");
  const projectRows = await db.select({ id: schema.projects.id }).from(schema.projects);
  const validProjectIds = new Set(projectRows.map((r) => r.id));
  let totalActions = 0;
  let skipped = 0;
  for (const { key: projectId, data } of blobs) {
    if (!validProjectIds.has(projectId)) { skipped++; continue; }
    const actions = JSON.parse(data) as Array<{ id: string; text: string; done: boolean }>;
    await db.delete(schema.manualActions).where(eq(schema.manualActions.projectId, projectId));
    if (actions.length > 0) {
      await db.insert(schema.manualActions).values(
        actions.map((a, i) => ({
          id: a.id,
          projectId,
          text: a.text,
          done: a.done,
          position: i,
        })),
      );
    }
    totalActions += actions.length;
  }
  console.log(`[backfill] manual-actions: ${blobs.length - skipped} projects, ${totalActions} actions (${skipped} orphaned, skipped)`);
}

async function backfillBuffrGlobal() {
  const blobs = await readAllBlobs("buffr-global");
  for (const { data } of blobs) {
    const item = JSON.parse(data);
    await db.insert(schema.buffrGlobal).values({
      id: item.id,
      filename: item.filename,
      path: item.path,
      category: item.category || "rules",
      title: item.title,
      content: item.content,
      createdAt: new Date(item.createdAt),
      updatedAt: new Date(item.updatedAt),
    }).onConflictDoUpdate({
      target: schema.buffrGlobal.id,
      set: {
        filename: item.filename,
        path: item.path,
        category: item.category || "rules",
        title: item.title,
        content: item.content,
        updatedAt: new Date(item.updatedAt),
      },
    });
  }
  console.log(`[backfill] buffr-global: ${blobs.length} entries`);
}

async function backfillBuffrSpecs() {
  const blobs = await readAllBlobs("buffr-specs");
  const projectRows = await db.select({ id: schema.projects.id }).from(schema.projects);
  const validProjectIds = new Set(projectRows.map((r) => r.id));
  let skipped = 0;
  for (const { data } of blobs) {
    const item = JSON.parse(data);
    if (!validProjectIds.has(item.scope)) { skipped++; continue; }
    await db.insert(schema.buffrSpecs).values({
      id: item.id,
      projectId: item.scope,
      category: item.category,
      filename: item.filename,
      path: item.path,
      title: item.title,
      content: item.content,
      status: item.status || "draft",
      createdAt: new Date(item.createdAt),
      updatedAt: new Date(item.updatedAt),
    }).onConflictDoUpdate({
      target: schema.buffrSpecs.id,
      set: {
        projectId: item.scope,
        category: item.category,
        filename: item.filename,
        path: item.path,
        title: item.title,
        content: item.content,
        status: item.status || "draft",
        updatedAt: new Date(item.updatedAt),
      },
    });
  }
  console.log(`[backfill] buffr-specs: ${blobs.length - skipped} entries (${skipped} orphaned, skipped)`);
}

async function backfillToolConfigs() {
  const blobs = await readAllBlobs("tool-config");
  for (const { data } of blobs) {
    const config = JSON.parse(data);
    await db.insert(schema.toolConfigs).values({
      integrationId: config.integrationId,
      values: config.values || {},
      enabled: config.enabled ?? false,
      updatedAt: new Date(config.updatedAt),
    }).onConflictDoUpdate({
      target: schema.toolConfigs.integrationId,
      set: {
        values: config.values || {},
        enabled: config.enabled ?? false,
        updatedAt: new Date(config.updatedAt),
      },
    });
  }
  console.log(`[backfill] tool-config: ${blobs.length} entries`);
}

async function backfillSettings() {
  const blobs = await readAllBlobs("settings");
  for (const { key, data } of blobs) {
    const value = JSON.parse(data);
    await db.insert(schema.settings).values({
      key,
      value,
    }).onConflictDoUpdate({
      target: schema.settings.key,
      set: { value },
    });
  }
  console.log(`[backfill] settings: ${blobs.length} entries`);
}

async function main() {
  console.log("[backfill] Starting Blob → Postgres backfill...\n");

  await backfillProjects();
  await backfillSessions();
  await backfillManualActions();
  await backfillBuffrGlobal();
  await backfillBuffrSpecs();
  await backfillToolConfigs();
  await backfillSettings();

  console.log("\n[backfill] Complete.");
  await client.end();
}

main().catch((err) => {
  console.error("[backfill] Failed:", err);
  process.exit(1);
});
