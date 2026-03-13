import { registerGitHubTools } from "./github";
import { registerNotionTools } from "./notion";

let registered = false;

/** Registers all integration tools. Safe to call multiple times. */
export function registerAllTools() {
  if (registered) return;
  registerGitHubTools();
  registerNotionTools();
  registered = true;
}
