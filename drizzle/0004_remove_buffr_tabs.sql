-- Hand-written migration: remove .buffr/* tables + manual_actions.spec_path.
-- Drizzle meta snapshots are NOT updated; regenerate with `npx drizzle-kit generate`
-- to bring meta back in sync (it should produce no further SQL diff).

DROP TABLE IF EXISTS "messages";--> statement-breakpoint
DROP TABLE IF EXISTS "conversations";--> statement-breakpoint
DROP TABLE IF EXISTS "buffr_specs";--> statement-breakpoint
DROP TABLE IF EXISTS "buffr_context";--> statement-breakpoint
DROP TABLE IF EXISTS "buffr_global";--> statement-breakpoint
ALTER TABLE "manual_actions" DROP COLUMN IF EXISTS "spec_path";
