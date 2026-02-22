import type { Context } from "@netlify/functions";
import { getAvailableProviders, getDefaultProvider } from "./lib/ai/provider";

export default async function handler(_req: Request, _context: Context) {
  const providers = getAvailableProviders();
  const defaultProvider = getDefaultProvider();

  return new Response(
    JSON.stringify({ providers, defaultProvider }),
    { headers: { "Content-Type": "application/json" } }
  );
}
