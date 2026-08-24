-- CT Surgery Sim Bundle / Clinical Patient Simulator - Supabase foundation
-- schema (Phase 3's held piece, built once a real project existed).
--
-- HOW TO APPLY: paste this whole file into the Supabase dashboard's
-- SQL Editor (https://supabase.com/dashboard/project/_/sql/new) and run it.
-- There is no Supabase CLI or MCP connector available in this project's dev
-- environment, so this is a plain SQL file rather than a CLI-managed
-- `supabase/migrations/*.sql` - if the CLI gets installed and linked later,
-- this file's contents are exactly what the first migration should contain.
--
-- Safe to re-run: every statement is idempotent (`if not exists` / `or
-- replace` / `drop policy if exists` before create).

-- ---------------------------------------------------------------------------
-- scenarios: Builder-authored, schema-v2 (stage-graph) scenarios.
-- ---------------------------------------------------------------------------
-- `id` is a real generated uuid, NOT the author's own scenario.id from the
-- JSON (that field is renamed `scenario_slug` here) - two different authors
-- may reasonably pick the same slug (e.g. both call it "tamponade-case"), and
-- using the slug as the primary key would make a second author's publish
-- either collide on insert or, worse, silently get blocked by the update RLS
-- policy on someone else's row with a confusing "permission denied" instead
-- of a clear "slug taken" error. The `unique(owner_id, scenario_slug)`
-- constraint below is the actual uniqueness rule that matters: one author
-- can't have two scenarios sharing a slug, but different authors can.
create table if not exists public.scenarios (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  scenario_slug text not null,
  title text not null default 'Untitled',
  population text,
  data jsonb not null,          -- the full v2 scenario JSON (schemaVersion, stages[], baseline, etc.)
  published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, scenario_slug)
);

comment on table public.scenarios is 'Schema-v2 (stage-graph) scenarios authored in builder/index.html. `data` is the exact JSON validateScenarioV2() checks and stageRunner.js runs - this table is a storage/sharing layer on top of that existing format, not a new one.';
comment on column public.scenarios.scenario_slug is 'The author''s own scenario.id from the JSON. Not globally unique - see the unique(owner_id, scenario_slug) constraint instead.';
comment on column public.scenarios.published is 'Gates whether an unauthenticated facilitator can SELECT this row (see policy below). Unpublishing does not affect a live session already running from a copy of the data - the console has no back-reference to this table once loaded.';

create index if not exists scenarios_published_idx on public.scenarios (published) where published;
create index if not exists scenarios_owner_idx on public.scenarios (owner_id);

-- Keep updated_at honest on every write, without every caller having to
-- remember to set it themselves.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists scenarios_set_updated_at on public.scenarios;
create trigger scenarios_set_updated_at
  before update on public.scenarios
  for each row
  execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
-- Matches the resolved role split from CLAUDE.md: Facilitator = run a
-- session, no login, needs read access to whatever's published; Author =
-- build/save scenarios, gated by Supabase Auth (magic link/OTP), needs full
-- CRUD on their own rows only. There is no separate "facilitator" or
-- "author" role/claim anywhere in this schema - "authenticated" IS "author"
-- (any signed-in user can publish), matching the approved decision that
-- magic-link alone is sufficient with no further allowlist/SSO gate. If that
-- changes later (e.g. restrict to an @med.usc.edu domain), that's a policy
-- change here, not a schema change.
alter table public.scenarios enable row level security;

drop policy if exists "published scenarios are publicly readable" on public.scenarios;
create policy "published scenarios are publicly readable"
  on public.scenarios for select
  using (published = true);

drop policy if exists "owners can read their own scenarios" on public.scenarios;
create policy "owners can read their own scenarios"
  on public.scenarios for select
  using (auth.uid() = owner_id);

drop policy if exists "authenticated users can insert their own scenarios" on public.scenarios;
create policy "authenticated users can insert their own scenarios"
  on public.scenarios for insert
  with check (auth.uid() = owner_id);

drop policy if exists "owners can update their own scenarios" on public.scenarios;
create policy "owners can update their own scenarios"
  on public.scenarios for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

drop policy if exists "owners can delete their own scenarios" on public.scenarios;
create policy "owners can delete their own scenarios"
  on public.scenarios for delete
  using (auth.uid() = owner_id);
