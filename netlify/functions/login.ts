import type { Context } from "@netlify/functions";
import { errorResponse } from "./lib/responses";
import { createToken, buildSetCookie } from "./lib/auth";

export default async function handler(req: Request, _context: Context) {
  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  try {
    const { username, password } = await req.json();

    const validUser = process.env.AUTH_USERNAME;
    const validPass = process.env.AUTH_PASSWORD;

    if (!validUser || !validPass) {
      return errorResponse("Auth credentials not configured", 500);
    }

    if (username !== validUser || password !== validPass) {
      return errorResponse("Invalid username or password", 401);
    }

    const token = await createToken();

    return new Response(JSON.stringify({ authenticated: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": buildSetCookie(token),
      },
    });
  } catch (err) {
    console.error("login function error:", err);
    return errorResponse("Internal server error", 500);
  }
}
