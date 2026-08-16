-- Core schema. Fifteen tables, not fifty-nine: every one of these is touched by
-- one of the five questions in docs/SPEC.md. See ADR-0002 before adding another.

-- ── Who is using the product ────────────────────────────────────────────────
-- A consultant, and the client organizations they represent. This is the
-- difference that shapes the whole product: the unit of work is a client, and
-- one person has many.
create table if not exists consultants (
  id uuid primary key,                       -- mirrors auth.users.id
  email text not null,
  display_name text,
  created_at timestamptz not null default now()
);

create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  consultant_id uuid not null references consultants(id) on delete cascade,
  name text not null,
  website text,
  country text not null default 'CA',
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists clients_consultant_idx on clients (consultant_id) where archived_at is null;

-- The engine's fuel. Kept in its own table because completeness is a
-- first-class product concern: matching quality decays with a stale profile,
-- and we have to be able to show a consultant exactly which field is missing.
create table if not exists client_profiles (
  client_id uuid primary key references clients(id) on delete cascade,
  sectors text[] not null default '{}',
  jurisdictions text[] not null default '{}',
  stage text,
  annual_budget numeric,
  currency text not null default 'CAD',
  capabilities text,
  beneficiaries text,
  extracted_from jsonb not null default '[]',  -- provenance of each auto-filled field
  reviewed_at timestamptz,                      -- last time a human confirmed it
  updated_at timestamptz not null default now()
);

-- ── What we know about the funding world ────────────────────────────────────
create table if not exists funders (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  country text not null,
  jurisdiction text,
  category text,
  website text,
  source_key text,
  created_at timestamptz not null default now(),
  unique (name, country)
);

create table if not exists grants (
  id uuid primary key default gen_random_uuid(),
  funder_id uuid not null references funders(id) on delete cascade,
  title text not null,
  summary text,
  url text not null,
  country text not null,
  currency text,
  amount_min numeric,
  amount_max numeric,
  deadline date,
  language text not null default 'en',
  source_key text not null,
  source_hash text not null unique,           -- stable across re-imports
  status text not null default 'open',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists grants_funder_idx on grants (funder_id);
create index if not exists grants_deadline_idx on grants (deadline) where status = 'open';

-- Lexical retrieval. tsvector + GIN deliberately, not a BM25 extension: see
-- ADR-0003. Generated so it can never drift from the row it describes.
alter table grants
  add column if not exists search_tsv tsvector
  generated always as (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(summary, '')), 'B')
  ) stored;
create index if not exists grants_search_tsv_idx on grants using gin (search_tsv);

-- Semantic retrieval, fused with the lexical side by RRF.
create table if not exists grant_embeddings (
  grant_id uuid primary key references grants(id) on delete cascade,
  embedding vector(768) not null,
  content_hash text not null,
  model text not null,
  updated_at timestamptz not null default now()
);

-- The differentiator the incumbent admits it lacks: who won this before.
create table if not exists past_awards (
  id uuid primary key default gen_random_uuid(),
  funder_id uuid references funders(id) on delete set null,
  grant_id uuid references grants(id) on delete set null,
  recipient_name text not null,
  amount numeric,
  awarded_on date,
  source_key text not null,
  source_hash text not null unique
);
create index if not exists past_awards_grant_idx on past_awards (grant_id);

-- ── The product's core output ───────────────────────────────────────────────
-- A match is a decision, not a search hit, so the verdict and its evidence are
-- stored rather than regenerated. "Why is this here?" must be answerable from
-- data months later.
create table if not exists matches (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  grant_id uuid not null references grants(id) on delete cascade,
  verdict text not null check (verdict in ('eligible', 'ineligible', 'needs_input')),
  relevance numeric,
  decided_at timestamptz not null default now(),
  unique (client_id, grant_id)
);
create index if not exists matches_client_verdict_idx on matches (client_id, verdict);

-- One row per rule evaluated. The rules decide; the model only ever explains.
create table if not exists eligibility_checks (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references matches(id) on delete cascade,
  rule_key text not null,
  passed boolean not null,
  is_hard_gate boolean not null default false,
  detail text not null
);
create index if not exists eligibility_checks_match_idx on eligibility_checks (match_id);

-- ── Writing ─────────────────────────────────────────────────────────────────
create table if not exists requirements (
  id uuid primary key default gen_random_uuid(),
  grant_id uuid not null references grants(id) on delete cascade,
  label text not null,
  detail text,
  is_critical boolean not null default false,
  sort_order integer not null default 0
);
create index if not exists requirements_grant_idx on requirements (grant_id);

create table if not exists proposals (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  grant_id uuid not null references grants(id) on delete cascade,
  status text not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, grant_id)
);

create table if not exists proposal_sections (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references proposals(id) on delete cascade,
  requirement_id uuid references requirements(id) on delete set null,
  heading text not null,
  content text,
  sort_order integer not null default 0,
  updated_at timestamptz not null default now()
);
create index if not exists proposal_sections_proposal_idx on proposal_sections (proposal_id);

-- A consultant answers "describe your organization's track record" dozens of
-- times per client. Storing those answers is where the promised time saving
-- actually comes from.
create table if not exists answer_library (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  label text not null,
  content text not null,
  times_used integer not null default 0,
  updated_at timestamptz not null default now()
);
create index if not exists answer_library_client_idx on answer_library (client_id);

create table if not exists submissions (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references proposals(id) on delete cascade,
  submitted_at timestamptz not null default now(),
  method text,
  confirmation_number text,
  human_reviewed_by uuid not null references consultants(id),
  outcome text
);

-- ── Observability ───────────────────────────────────────────────────────────
create table if not exists agent_runs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references clients(id) on delete cascade,
  agent text not null,
  status text not null,
  provider text,
  model text,
  latency_ms integer,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists agent_runs_recent_idx on agent_runs (created_at desc);
