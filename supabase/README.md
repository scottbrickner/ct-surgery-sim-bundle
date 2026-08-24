# Supabase foundation

The piece explicitly held back in Phase 3 ("start on the UI restructuring
now, hold Supabase until it's set up") until a real project existed. Project:
`ixzjhchfgicxgaqhmkku` (`https://ixzjhchfgicxgaqhmkku.supabase.co`, region
`us-east-1`).

No Supabase CLI or MCP connector is available in this dev environment, so
there's no automated migration/config path - the two steps below are
dashboard-only and need to be done by hand (once), by whoever has access to
the project.

## 1. Apply the schema

Open the [SQL Editor](https://supabase.com/dashboard/project/ixzjhchfgicxgaqhmkku/sql/new)
and paste in the entire contents of `schema.sql`, then run it. It's
idempotent - safe to re-run if you're not sure it already applied.

This creates one table (`scenarios`) with Row Level Security policies
matching the resolved role split: anyone (including an unauthenticated
facilitator) can read a *published* scenario; only the owning author can
read/write their own unpublished drafts or make any change at all.

## 2. Configure Auth → URL Configuration

Go to **Authentication → URL Configuration** in the dashboard and add every
URL the Scenario Builder might be opened from to **Redirect URLs**:

- `https://ct-surgery-sim.netlify.app/builder/` (production)
- `http://localhost:8080/builder/` (local dev via `node serve.js`)

Without this, clicking the magic-link email will fail to redirect back into
the Builder with a valid session (Supabase rejects redirects to URLs not on
this allow-list). The **Site URL** field can stay whatever it currently is -
this project doesn't rely on it specifically, only the allow-list matters
here.

You do NOT need to touch the email template - the default "Magic Link"
template already includes both a clickable link and a 6-digit `{{ .Token }}`
code, and `builder/index.html`'s sign-in UI uses the code path
(`verifyOtp`) as the primary flow specifically so it keeps working if the
Builder is ever opened inside a SharePoint/Teams iframe, where a
link-triggered top-level redirect can behave unpredictably. Reading a code
out of an email and typing it into the page works the same everywhere.

## Known open issue: custom SMTP send isn't reaching Resend

As of 2026-08-23, Supabase's custom SMTP relay to Resend isn't delivering
email, and it isn't a code problem - it's between Supabase's and Resend's
infrastructure. What was ruled out, in order:

1. **Supabase's built-in (no-SMTP) sender** works but is both rate-limited
   (hit "email rate limit exceeded" after 2 sends) and can't have its
   template edited to include `{{ .Token }}` (locked unless custom SMTP is
   enabled) - this is why custom SMTP was set up at all.
2. **Custom SMTP via Resend, port 465** - `signInWithOtp` returns success
   (Supabase's own Auth logs show `200 POST /auth/v1/otp`) but the email
   never arrives, and **Resend's own Logs page shows zero incoming
   connection attempts** - not a bounce, not an auth failure, nothing.
3. **Confirmed Resend itself works**: Resend's own dashboard "send a test
   email" button (same `onboarding@resend.dev` -> the test address,
   bypassing Supabase entirely) delivered successfully. So the problem is
   specifically Supabase's connection to `smtp.resend.com`, not Resend's
   ability to reach this inbox.
4. **Port 587 instead of 465** - same result as (2): API call succeeds,
   Resend logs show nothing.

Zero connection attempts ever registering in Resend's logs (rather than a
logged-and-rejected auth failure) suggests the SMTP connection itself isn't
completing - a network/firewall issue between Supabase's infrastructure and
Resend's, or a subtler config mismatch neither side's dashboard surfaces.
This needs Supabase's or Resend's own support to diagnose from their end -
neither side of this integration can see the other's infrastructure logs
from the outside.

**This does not block anything else in this foundation.** The auth code
(`builder/index.html`'s `signInWithOtp`/`verifyOtp` calls, the `scenarios`
table, its RLS policies, the publish/load/browse flow) is all correct and
independently verifiable via code review - it needs a working session to
exercise end-to-end, not a fix. The moment email delivery starts working
(whether via resolving this Resend issue, trying a different SMTP provider,
or Resend domain verification), sign-in works too, with zero code changes.

Things worth trying if you pick this back up:
- Resend domain verification (moves off the `onboarding@resend.dev` sandbox
  address onto a fully-supported sending path - may sidestep whatever
  sandbox-specific restriction is in play)
- Supabase support / status page, in case this is a known platform-side
  issue at the time you're reading this
- A different SMTP provider (Postmark, SendGrid) as a process of elimination
  - if a second provider also shows zero connection attempts, that's a
  stronger signal the issue is Supabase-side, not Resend-side

## What's NOT part of this foundation

- **No allowlist/domain restriction on who can sign in.** Per the resolved
  decision ("supabase auth magic-link should be enough", CLAUDE.md), any
  email address can request a code and become an "author" able to publish
  scenarios facilitators will trust and run live. There's no separate
  `role` claim - "authenticated" IS "author" here. If that turns out to be
  too permissive for a real deployment, the fix is a Postgres auth hook or a
  domain check in the `insert`/`update` policies in `schema.sql`, not a
  schema rewrite.
- **No session-sync migration to Supabase Realtime.** Cross-device sync
  during a live session still runs entirely on `sync/deviceSync.js`
  (BroadcastChannel + the existing WebSocket relay on Render). This
  foundation is scoped to scenario storage/sharing + author auth only - a
  session real-time database on top of `sync/deviceSync.js`'s wire format is
  a separate, later piece if it's ever needed (same-machine and relay sync
  both already work without it).
- **Facilitator role still has no login of any kind** - by design. The
  Console's new "Cloud" scenario browser reads `published = true` rows
  through the anon/publishable key with no session at all, exactly matching
  how the Console already works today.
