/**
 * Runs a DB write only if DB_WRITE_ENABLED=true.
 * Failures are logged silently — never surfaced to the user.
 */
export async function dbWrite(label: string, fn: () => Promise<void>): Promise<void> {
  if (process.env.DB_WRITE_ENABLED !== "true") return;
  try {
    await fn();
  } catch (e) {
    console.error(`[db write] ${label}:`, e);
  }
}
