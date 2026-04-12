import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./netlify/functions/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.NETLIFY_DATABASE_URL!,
  },
});
