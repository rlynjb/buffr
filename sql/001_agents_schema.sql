create extension if not exists vector;
create schema if not exists agents;

create table if not exists agents.documents (
  id text primary key,
  app_id text not null default 'laptop',
  source_type text not null,
  source_path text,
  content text not null,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists agents.chunks (
  id text primary key,
  -- Soft link to documents.id (no FK): the VectorStore contract upserts chunks
  -- with no notion of a documents row, so a hard FK would break drop-in parity.
  document_id text,
  app_id text not null default 'laptop',
  chunk_index int not null,
  content text not null,
  embedding vector(768) not null,
  embedding_model text not null default 'nomic-embed-text:v1.5',
  meta jsonb not null default '{}'
);
-- Drop the FK on databases migrated before this change (idempotent).
alter table agents.chunks drop constraint if exists chunks_document_id_fkey;
create index if not exists chunks_embedding_hnsw
  on agents.chunks using hnsw (embedding vector_cosine_ops);
create index if not exists chunks_app_id on agents.chunks (app_id);

create table if not exists agents.conversations (
  id uuid primary key default gen_random_uuid(),
  app_id text not null default 'laptop',
  user_id text,
  agent_name text not null default 'rag-query-agent',
  created_at timestamptz not null default now()
);

create table if not exists agents.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references agents.conversations(id) on delete cascade,
  role text not null,
  content text not null default '',
  tool_calls jsonb,
  tool_results jsonb,
  model text,
  tokens_used int,
  created_at timestamptz not null default now()
);

create table if not exists agents.profiles (
  id uuid primary key default gen_random_uuid(),
  app_id text not null default 'laptop',
  user_id text,
  content text not null,
  updated_at timestamptz not null default now()
);
