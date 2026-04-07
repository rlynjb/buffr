import { registerGitHubTools } from "./github";

let registered = false;

/** Registers all integration tools. Safe to call multiple times. */
export function registerAllTools() {
  if (registered) return;
  registerGitHubTools();
  registered = true;
}
