create table if not exists agents.decisions (
  id uuid primary key default gen_random_uuid(),
  app_id text not null default 'laptop',
  user_id text not null,
  workspace_id text not null,
  domain text not null,
  subject_type text not null,
  subject_id text not null,
  kind text not null check (kind in ('hypothesis', 'decision')),
  claim text not null,
  evidence_ids jsonb not null default '[]',
  created_at timestamptz not null default now(),
  status text not null default 'open' check (status in ('open', 'review-due', 'resolved', 'discarded')),
  stake text,
  resolution_condition text,
  review_at timestamptz,
  predicted_score numeric,
  predicted_dimension text,
  predicted_confidence numeric,
  assessed_score numeric,
  assessed_confidence numeric,
  disposition text check (disposition in ('successful', 'unsuccessful', 'inconclusive')),
  note text,
  resolved_at timestamptz
);
create index if not exists decisions_app_id on agents.decisions (app_id);
create index if not exists decisions_status_review on agents.decisions (app_id, user_id, workspace_id, status, review_at);
