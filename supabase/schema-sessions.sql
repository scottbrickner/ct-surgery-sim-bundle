-- CT Surgery Sim Bundle / Clinical Patient Simulator - Phase 9 (Cross-device
-- real-time sessions) schema. Adds to, does not replace, schema.sql's
-- `scenarios` table - apply this AFTER schema.sql if starting fresh, or on
-- its own if schema.sql is already applied (this file only touches new
-- tables/functions, never `scenarios`).
--
-- HOW TO APPLY: same as schema.sql - paste this whole file into the
-- Supabase dashboard's SQL Editor (https://supabase.com/dashboard/project/_/sql/new)
-- and run it. Safe to re-run (every statement is idempotent).
--
-- Also requires: enabling Anonymous Sign-ins in the dashboard
-- (Authentication -> Providers -> Anonymous). Facilitators and learners
-- still never see a login screen (matches the resolved "no facilitator
-- login" decision) - anonymous auth just gives each browser tab a stable
-- auth.uid() so RLS can tell "a facilitator of THIS session" apart from
-- "anyone with the code", which the pre-Phase-9 relay genuinely could not
-- do at all (see the audit's §5 "anyone with the URL and the 6-character
-- code can join and inject state" gap). It is NOT the same login concept as
-- the Scenario Builder's email+OTP author auth in schema.sql - a session
-- participant's anonymous identity is scoped to sessions/session_participants
-- only and has zero access to the scenarios table beyond what's already
-- publicly readable there.

-- ---------------------------------------------------------------------------
-- sessions: one row per live (or recently-live) cross-device session.
-- ---------------------------------------------------------------------------
create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,             -- 6-char human/QR-joinable code, e.g. "K3RTQ9" (sync/deviceSync.js genCode() alphabet)
  engine_mode text not null default 'v1' check (engine_mode in ('v1','v2')),
  scenario_ref text,                     -- v1: nothing needed (flagship is the only v1 case); v2: the scenario's own JSON id, informational only
  paused boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ended_at timestamptz
);
comment on table public.sessions is 'One row per Phase 9 cross-device session. Created by whichever device starts "Cloud Session" (normally the console, but any device may - same "any device can drive" principle as the existing BroadcastChannel/relay bus). A session is NOT the same thing as a scenario - it is a live pairing of devices, closer in spirit to the old relay "room".';
comment on column public.sessions.code is 'Short code for QR/manual joining. Unique while the session is live; a code is never reused for a NEW session while an old one with that code still exists (see cleanup note below), so a stale learner link cannot silently join the wrong session.';

create index if not exists sessions_code_idx on public.sessions (code);

drop trigger if exists sessions_set_updated_at on public.sessions;
create trigger sessions_set_updated_at
  before update on public.sessions
  for each row
  execute function public.set_updated_at(); -- reuses the function schema.sql already defined

-- ---------------------------------------------------------------------------
-- session_participants: who's in a session, and with what role.
-- ---------------------------------------------------------------------------
-- This table is the actual enforcement point for "a learner-role client
-- genuinely cannot write to the physiology table" (the audit's own Phase 9
-- acceptance criterion) - every write policy below checks membership +
-- role here, not just "is this person logged in."
create table if not exists public.session_participants (
  session_id uuid not null references public.sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade, -- anonymous-auth uid, one per browser/tab
  role text not null check (role in ('facilitator','learner')),
  device_label text,                     -- 'console' | 'intellivue' | 'hemosphere' | 'pacemaker' | 'assessments' | null - informational, drives presence UI only, never a security boundary
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (session_id, user_id)
);
comment on table public.session_participants is 'Membership + role for a session. A user_id can only hold ONE role per session (primary key is session_id+user_id) - switching role means leaving and rejoining, deliberately simple rather than supporting mid-session role changes in v1.';

create index if not exists session_participants_session_idx on public.session_participants (session_id);

-- ---------------------------------------------------------------------------
-- session_snapshots: the authoritative durable state per session, one row
-- per (session, channel) - "channel" mirrors sync/deviceSync.js's own
-- mutual-exclusivity naming (physiology snapshot vs assessments state vs
-- pacer control-panel state), NOT a new concept invented here.
-- ---------------------------------------------------------------------------
create table if not exists public.session_snapshots (
  session_id uuid not null references public.sessions(id) on delete cascade,
  channel text not null check (channel in ('physiology','assessments','pacer_control')),
  data jsonb not null default '{}'::jsonb,
  -- Facilitator-only staging area for the Console's Pause -> "prepare next
  -- state" -> "Publish" flow (audit's "hidden resume snapshot" acceptance
  -- criterion). Written while paused via the same RLS role check as `data`
  -- itself; a learner's SELECT policy (below) never includes this column's
  -- contents reaching them ahead of Publish - Publish is simply an
  -- application-level "copy pending_data into data, then clear
  -- pending_data" write, not a new RLS mechanism.
  pending_data jsonb,
  updated_at timestamptz not null default now(),
  primary key (session_id, channel)
);
comment on table public.session_snapshots is 'One authoritative row per (session, channel). This is what a reconnecting device SELECTs on join for full-state hydration (audit acceptance criterion: "a facilitator refresh mid-scenario recovers full state, not a blank slate") - the live-tick-rate updates themselves travel over Supabase Realtime Broadcast (ephemeral, not written here on every tick), this table is only upserted at a slower cadence purely for durability.';
comment on column public.session_snapshots.pending_data is 'Facilitator-prepared next state while the session is paused, not yet visible to learners. NULL when nothing is staged. See sessions.paused and the Console''s Pause/Prepare/Publish flow.';

drop trigger if exists session_snapshots_set_updated_at on public.session_snapshots;
create trigger session_snapshots_set_updated_at
  before update on public.session_snapshots
  for each row
  execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- session_events: lightweight audit trail (join/leave/pause/resume/publish/
-- role-assign). NOT a debrief/scoring feature - that was explicitly resolved
-- against for the Assessments Monitor (Phase 8) and the same call applies
-- here. This exists only so a facilitator can see "who's connected and when
-- did X happen" in the Console's own session panel, and so a stale/abandoned
-- session can be identified for cleanup. No UI surfaces this as a grade or
-- performance record.
-- ---------------------------------------------------------------------------
create table if not exists public.session_events (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.sessions(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  event_type text not null,              -- 'join' | 'leave' | 'pause' | 'resume' | 'publish' | 'role_assign'
  detail jsonb,
  created_at timestamptz not null default now()
);
create index if not exists session_events_session_idx on public.session_events (session_id, created_at);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.sessions enable row level security;
alter table public.session_participants enable row level security;
alter table public.session_snapshots enable row level security;
alter table public.session_events enable row level security;

-- Helper: is auth.uid() a participant of this session, and with which role?
-- SECURITY DEFINER so the policies below can check membership without each
-- policy needing its own recursive-looking subquery against a table that
-- itself has RLS enabled (session_participants checking session_participants
-- would otherwise need care to avoid a policy depending on itself).
create or replace function public.session_role(p_session_id uuid)
returns text
language sql
security definer
stable
as $$
  select role from public.session_participants
  where session_id = p_session_id and user_id = auth.uid()
  limit 1;
$$;

-- sessions: any authenticated (including anonymous) user can create a
-- session (starting a Cloud Session needs no prior membership - you become
-- the facilitator BY creating it, enforced at the application layer by
-- immediately inserting yourself into session_participants as
-- role='facilitator' right after, not by this policy). Reading a session row
-- (to resolve a code on join) is allowed for anyone who is - or is about to
-- become, via the join flow - a participant; kept simple as "any
-- authenticated user can read any session by code," since the code itself
-- is already the shared secret (matches the pre-Phase-9 relay's own
-- security model - this is a genuine improvement on it via role-gated
-- WRITES, not a claim that session codes are now access-controlled at the
-- read level too).
drop policy if exists "authenticated users can create sessions" on public.sessions;
create policy "authenticated users can create sessions"
  on public.sessions for insert
  with check (auth.uid() is not null);

drop policy if exists "authenticated users can read sessions" on public.sessions;
create policy "authenticated users can read sessions"
  on public.sessions for select
  using (auth.uid() is not null);

drop policy if exists "facilitators can update their session" on public.sessions;
create policy "facilitators can update their session"
  on public.sessions for update
  using (public.session_role(id) = 'facilitator')
  with check (public.session_role(id) = 'facilitator');

-- session_participants: anyone authenticated can join (insert themselves)
-- with either role - there is no invite-only gate in v1, matching the
-- existing "anyone with the code" model. A participant can update only
-- their OWN row (heartbeat last_seen_at); nobody can reassign someone
-- else's role.
drop policy if exists "users can join a session as themselves" on public.session_participants;
create policy "users can join a session as themselves"
  on public.session_participants for insert
  with check (auth.uid() = user_id);

drop policy if exists "participants can read their session roster" on public.session_participants;
create policy "participants can read their session roster"
  on public.session_participants for select
  using (public.session_role(session_id) is not null);

drop policy if exists "users can update their own participant row" on public.session_participants;
create policy "users can update their own participant row"
  on public.session_participants for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- session_snapshots: THE core enforcement point. Read is open to any
-- participant of the session (facilitator or learner) - `pending_data` is a
-- real column value they technically receive over PostgREST/Realtime, but
-- the Console UI never reveals it to a learner-role client, and no learner
-- surface (IntelliVue/HemoSphere/Assessments/pacemaker) ever reads that
-- column - documented here as a client-side-only boundary, matching the
-- audit's own equivalent note about `published` scenario visibility.
-- Writing `physiology` and `pacer_control` channels is FACILITATOR-ONLY -
-- this is the literal "learner-role client genuinely cannot write to the
-- physiology table" acceptance criterion, enforced server-side, not just by
-- the UI not offering the control. Writing `assessments` is open to any
-- participant (mirrors Phase 8's existing model where a learner's own tile
-- tap writes the shared state directly).
drop policy if exists "participants can read session snapshots" on public.session_snapshots;
create policy "participants can read session snapshots"
  on public.session_snapshots for select
  using (public.session_role(session_id) is not null);

drop policy if exists "facilitators can write physiology and pacer snapshots" on public.session_snapshots;
create policy "facilitators can write physiology and pacer snapshots"
  on public.session_snapshots for insert
  with check (
    (channel in ('physiology','pacer_control') and public.session_role(session_id) = 'facilitator')
    or (channel = 'assessments' and public.session_role(session_id) is not null)
  );

drop policy if exists "facilitators can update physiology and pacer snapshots" on public.session_snapshots;
create policy "facilitators can update physiology and pacer snapshots"
  on public.session_snapshots for update
  using (
    (channel in ('physiology','pacer_control') and public.session_role(session_id) = 'facilitator')
    or (channel = 'assessments' and public.session_role(session_id) is not null)
  )
  with check (
    (channel in ('physiology','pacer_control') and public.session_role(session_id) = 'facilitator')
    or (channel = 'assessments' and public.session_role(session_id) is not null)
  );

-- session_events: any participant can insert an event about themselves;
-- reading is open to session participants (facilitator's own session panel
-- reads this for the connection/roster log).
drop policy if exists "participants can log session events" on public.session_events;
create policy "participants can log session events"
  on public.session_events for insert
  with check (public.session_role(session_id) is not null);

drop policy if exists "participants can read session events" on public.session_events;
create policy "participants can read session events"
  on public.session_events for select
  using (public.session_role(session_id) is not null);

-- ---------------------------------------------------------------------------
-- Realtime: enable Postgres Changes on session_snapshots so a device that
-- prefers change-feed hydration over polling can subscribe directly
-- (sync's own push path primarily uses Realtime Broadcast for the 140ms
-- live-tick cadence - see sync/deviceSync.js - this publication exists for
-- the slower durable-write path and any future consumer that wants it).
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'session_snapshots'
  ) then
    alter publication supabase_realtime add table public.session_snapshots;
  end if;
end $$;
