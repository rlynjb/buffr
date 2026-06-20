import pg from 'pg';

/** Reads the most recent profile (me.md) for an app, or '' if none stored. */
export async function loadProfile(pool: pg.Pool, appId: string): Promise<string> {
  const { rows } = await pool.query(
    'select content from agents.profiles where app_id = $1 order by updated_at desc limit 1', [appId]);
  return rows[0]?.content ?? '';
}
