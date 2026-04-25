import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// --- Projects ---

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    stack: text("stack").notNull().default(""),
    phase: text("phase").notNull(),
    githubRepo: text("github_repo"),
    netlifySiteUrl: text("netlify_site_url"),
    dataSources: text("data_sources").array().notNull().default(sql`'{}'::text[]`),
    dismissedSuggestions: text("dismissed_suggestions").array().notNull().default(sql`'{}'::text[]`),
    lastSessionId: uuid("last_session_id"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("projects_updated_at_idx").on(table.updatedAt),
  ],
);

// --- Sessions ---

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    goal: text("goal").notNull(),
    whatChanged: text("what_changed").array().notNull().default(sql`'{}'::text[]`),
    blockers: text("blockers"),
    detectedIntent: text("detected_intent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("sessions_project_id_created_at_idx").on(table.projectId, table.createdAt),
  ],
);

// --- Manual Actions (one row per action — fixes race condition) ---

export const manualActions = pgTable(
  "manual_actions",
  {
    id: text("id").primaryKey(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    done: boolean("done").notNull().default(false),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("manual_actions_project_id_position_idx").on(table.projectId, table.position),
  ],
);

// --- Tool Config ---

export const toolConfigs = pgTable("tool_configs", {
  integrationId: text("integration_id").primaryKey(),
  values: jsonb("values").notNull().default({}),
  enabled: boolean("enabled").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- App-wide Settings ---

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
});
