import type { Context } from "@netlify/functions";
import { getAvailableProviders, getDefaultProvider } from "./lib/ai/provider";
import { json } from "./lib/responses";

export default async function handler(_req: Request, _context: Context) {
  const providers = getAvailableProviders();
  const defaultProvider = getDefaultProvider();

  return json({ providers, defaultProvider });
}
