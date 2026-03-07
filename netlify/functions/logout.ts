import type { Context } from "@netlify/functions";
import { buildClearCookie } from "./lib/auth";

export default async function handler(_req: Request, _context: Context) {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": buildClearCookie(),
    },
  });
}
