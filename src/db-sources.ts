export type DbSource = {
  schema: string;
  table: string;
  query: string;
  toId: (row: Record<string, unknown>) => string;
  toText: (row: Record<string, unknown>) => string;
};

export const DB_SOURCES: DbSource[] = [
  {
    schema: 'loopd',
    table: 'entries',
    query: `SELECT id, date, text FROM loopd.entries WHERE deleted_at IS NULL AND text IS NOT NULL AND text <> ''`,
    toId: (r) => `loopd/entries/${r['id']}`,
    toText: (r) => `Journal entry ${r['date']}: ${r['text']}`,
  },
  {
    schema: 'loopd',
    table: 'todo_meta',
    query: `SELECT todo_id, entry_date, type, stage, expanded_md FROM loopd.todo_meta WHERE deleted_at IS NULL AND expanded_md IS NOT NULL`,
    toId: (r) => `loopd/todo/${r['todo_id']}`,
    toText: (r) => `Task [${r['type']}] (${r['stage']}) on ${r['entry_date']}: ${r['expanded_md']}`,
  },
  {
    schema: 'loopd',
    table: 'nutrition',
    query: `SELECT id, entry_date, name, kcal FROM loopd.nutrition WHERE deleted_at IS NULL`,
    toId: (r) => `loopd/nutrition/${r['id']}`,
    toText: (r) => `Nutrition on ${r['entry_date']}: ${r['name']} (${r['kcal']} kcal)`,
  },
  {
    schema: 'loopd',
    table: 'vlogs',
    query: `SELECT id, date, caption, clip_count FROM loopd.vlogs WHERE deleted_at IS NULL AND caption IS NOT NULL AND caption <> ''`,
    toId: (r) => `loopd/vlogs/${r['id']}`,
    toText: (r) => `Vlog on ${r['date']}: ${r['caption']} (${r['clip_count']} clips)`,
  },
  {
    schema: 'loopd',
    table: 'habits',
    query: `SELECT id, label, cadence_type, time_of_day FROM loopd.habits WHERE (archived IS NOT TRUE) AND deleted_at IS NULL`,
    toId: (r) => `loopd/habits/${r['id']}`,
    toText: (r) => `Habit: ${r['label']} (${r['cadence_type']}, ${r['time_of_day']})`,
  },
  {
    schema: 'contrl',
    table: 'exercises',
    query: `SELECT id, name, category, level, target_sets, target_reps, notes FROM contrl.exercises`,
    toId: (r) => `contrl/exercises/${r['id']}`,
    toText: (r) =>
      `Exercise: ${r['name']} (${r['category']}, level ${r['level']}) — ${r['target_sets']}×${r['target_reps']}. ${r['notes'] ?? ''}`.trimEnd(),
  },
  {
    schema: 'contrl',
    table: 'sessions',
    query: `SELECT id, date, level, category, notes, passed FROM contrl.sessions`,
    toId: (r) => `contrl/sessions/${r['id']}`,
    toText: (r) =>
      `Workout on ${r['date']}: ${r['category']} level ${r['level']}, ${r['passed'] ? 'passed' : 'failed'}. ${r['notes'] ?? ''}`.trimEnd(),
  },
  {
    schema: 'contrl',
    table: 'week_progress',
    query: `SELECT week_start, push_done, pull_done, squat_done FROM contrl.week_progress`,
    toId: (r) => `contrl/week/${r['week_start']}`,
    toText: (r) =>
      `Week of ${r['week_start']}: push=${r['push_done']}, pull=${r['pull_done']}, squat=${r['squat_done']}`,
  },
];
