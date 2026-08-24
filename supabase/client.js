// Supabase client - the Phase 3 foundation piece deliberately held back until
// a real Supabase project existed (user's explicit instruction: "start on the
// UI restructuring now, hold Supabase until it's set up"). See supabase/README.md
// for what to configure in the dashboard and supabase/schema.sql for the
// migration this client's calls assume is already applied.
//
// Loaded via ESM CDN import (esm.sh), not an npm dependency - matches this
// project's zero-build-step convention (see CLAUDE.md's "no bundler/framework
// without a reason tied to an actual phase's needs"). Adding a real npm
// dependency here would mean introducing a build step project-wide just for
// this one client, which isn't worth it while everything else stays
// plain-file-served.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Project URL + PUBLISHABLE key (Supabase's current name for what used to be
// called the "anon" key) - safe to commit and embed in client-side code. This
// is the whole design of Supabase's security model: this key identifies the
// PROJECT, not a user or a secret: it grants exactly what each table's Row
// Level Security policies (see schema.sql) allow, nothing more. Real access
// control comes from RLS + Supabase Auth sessions, not from keeping this
// value hidden.
//
// NEVER put the service_role/secret key here or anywhere else client-side -
// that key bypasses RLS entirely and is meant for a trusted server process
// only, which this project has none of (it's a static site with no backend).
const SUPABASE_URL = 'https://ixzjhchfgicxgaqhmkku.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_5MEQDil_WX4DGO0SHK099w_mSYoOMYA';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
