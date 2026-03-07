import type { Context } from "@netlify/functions";
import { json } from "./lib/responses";
import { parseCookie, verifyToken } from "./lib/auth";

export default async function handler(req: Request, _context: Context) {
  const cookieHeader = req.headers.get("cookie");
  const token = parseCookie(cookieHeader);

  if (!token) {
    return json({ authenticated: false });
  }

  const valid = await verifyToken(token);
  return json({ authenticated: valid });
}
