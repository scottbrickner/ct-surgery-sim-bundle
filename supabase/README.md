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

**2026-08-24 follow-up**: rotated the Resend API key (unrelated security
hygiene - the original key had been pasted into a chat session) and retried
with the fresh key. Identical result - zero connection attempts in Resend's
Logs. This rules out a stale/wrong credential as the cause.

Leading hypothesis now: Resend's SMTP relay may enforce stricter
sender-verification than its HTTP API sandbox does. The dashboard's
"send a test email" button that worked uses Resend's HTTP API directly with
relaxed sandbox rules for `onboarding@resend.dev`; the SMTP interface may
reject/drop an unauthenticated relay attempt from an unverified sending
domain before it would ever create a log entry - which fits every symptom
observed (API always succeeds client-side, SMTP never registers server-side,
regardless of port or credential).

The user does not currently own a domain to verify (the standard fix for
this class of issue), so as of this writing the plan is: a support request
has been drafted describing the exact symptom (SMTP invisible to Logs, API
works) for Resend to check server-side - see chat history around
2026-08-24 for the drafted message text, or re-derive it from this file's
description above. Sending it, and following up with Resend support's
answer, is the next concrete step whenever this gets picked back up.

**2026-08-27 follow-up**: as a temporary unblock while the Resend SMTP issue
above remains unresolved, custom SMTP was disabled to fall back to
Supabase's built-in (no-SMTP) sender. That immediately surfaced a second,
previously-undocumented (and incorrectly assumed-fixed) issue: **the actual
Magic Link email template in this project did NOT contain `{{ .Token }}`**
- despite this file's own "Configure Auth" section above claiming "the
default 'Magic Link' template already includes both a clickable link and a
6-digit `{{ .Token }}` code." That claim was wrong for this project's actual
template state (never independently verified in the dashboard before now -
correcting it here rather than leaving stale docs in place). Fixed by
manually adding `{{ .Token }}` to the template body via **Authentication ->
Emails -> Templates -> Magic Link** in the dashboard - the editor was NOT
locked while on the built-in sender, contradicting this file's other
assumption ("locked unless custom SMTP is enabled"). Both stale assumptions
are corrected by this note; don't trust either one without checking the
dashboard directly first.

With the token now in the template, the built-in sender should deliver a
working 6-digit code. Its ~2-sends/hour rate limit was hit during this same
troubleshooting session (two sign-in attempts), so final end-to-end
confirmation (code arrives, `verifyOtp` succeeds) is still pending an hourly
reset as of this note - not yet a fully closed loop, but the template gap
itself is fixed and shouldn't need touching again.

**2026-08-28 follow-up**: a real email arrived (screenshot in hand) - and
the code in it is **8 digits** (`83004403`), not 6. This project's own
`builder/index.html` sign-in field had `maxlength="6"` hardcoded, so even
though the email itself was now correct, the code was PHYSICALLY impossible
to type in full - it got silently truncated to the first 6 digits, which
then fails `verifyOtp` with no obvious reason why. That's a real app-side
bug now fixed (widened the field, de-specified the label/placeholder/status
copy from "6-digit" to plain "sign-in code" so it can't silently break again
if Supabase's own OTP length setting ever changes back). **This file's own
"should deliver a working 6-digit code" line above (2026-08-27 follow-up)
is now known to be an unverified assumption, not a checked fact** - don't
trust the digit count without checking a real email first. The Supabase-side
piece (does the code actually verify now that the field can hold it) is
still the next thing to confirm end-to-end once the rate limit allows
another real attempt.

**2026-08-28, same day, root cause found - confirmed via Supabase's own
Auth Logs, not guessed.** With the field fixed, a fresh 8-digit code still
failed with "Token has expired or is invalid" on every attempt. The Logs
(**Authentication → Logs** in the dashboard) told the real story:

```
17:01:01  POST /auth/v1/otp                          200   (code emailed)
17:01:16  GET  /auth/v1/verify?token=e2392082...      303   (x2)
17:01:30  POST /auth/v1/verify                        403
17:01:38  POST /auth/v1/verify                        403
17:01:39  POST /auth/v1/verify                        403
17:01:40  POST /auth/v1/verify                        403
```

The `GET /auth/v1/verify?token=...` at 17:01:16 - **15 seconds** after the
email sent, far too fast for a human to have read the email and clicked
anything - is the email's own clickable magic link being auto-visited.
Almost certainly USC's email security scanner (Microsoft Defender for
Office 365 Safe Links or equivalent) pre-fetching every link in incoming
mail to scan for malware, before the recipient ever opens it.

**The magic link and the 8-digit code represent the SAME one-time token.**
The instant the scanner's GET consumes it, the code representing that same
token is dead - so every subsequent `POST /auth/v1/verify` (the human
actually typing the code in) gets 403, even entered within seconds of
receiving the email. This is why widening the code field wasn't enough by
itself: the field bug and this one were two independent, stacked problems
hitting the same sign-in attempt.

**The fix: remove the clickable link from the email template entirely,
leaving only `{{ .Token }}`.** With no link in the email, there's nothing
for a scanner to prefetch and burn. Apply via **Authentication → Emails →
Templates → Magic Link**, replacing the body with:

```html
<h2>Your sign-in code</h2>
<p>Enter this code on the Scenario Builder sign-in screen:</p>
<p style="font-size: 28px; font-weight: 700; letter-spacing: 4px;">{{ .Token }}</p>
<p>This code expires shortly and can only be used once. If you didn't request this, you can ignore this email.</p>
```

No other links anywhere in the template either (no logo image, no
unsubscribe footer link) - any link is fetchable by the same scanner, so
the safest version of this fix is a template with zero clickable URLs, not
just the removal of the one that happens to matter. Once applied, this
also makes the earlier "code-entry over magic-link, in case of an iframe
redirect" design decision (see the top of this file) doubly correct: the
link was never just unreliable inside an iframe, it was actively
self-defeating outside one too.

**CONFIRMED working, same day.** After the rate limit reset, the user
applied the link-free template and signed in successfully on the first
try - screen showed "Signed in as scott.brickner2@med.usc.edu." **Builder
sign-in is fully functional end-to-end as of this note** - the whole saga
(custom SMTP silently not delivering → built-in sender missing `{{
.Token }}` → the 6-digit field truncating a real 8-digit code → the magic
link's own auto-scanned token starving the code before it could be used)
is closed. Nothing left to troubleshoot here unless a new symptom shows up.

~~Things worth trying if you pick this back up:~~ *(left below for
reference/history now that the issue is closed, not as an active TODO)*
- Send the drafted Resend support request (see above) and act on their
  answer - this is the most likely fastest path to a real diagnosis at
  this point, now that credential/port/rate-limit/template have all been
  ruled out.
- Domain verification, if a domain becomes available later (own one for
  another project, buy one for ~$10-15/yr, etc.) - moves off the sandbox
  restrictions entirely regardless of what the actual root cause turns out
  to be.
- Supabase support / status page, in case this is a known platform-side
  issue at the time you're reading this.
- A different SMTP provider (Postmark, SendGrid) as a process of elimination
  - if a second provider also shows zero connection attempts, that's a
  stronger signal the issue is Supabase-side, not Resend-side.

## What's NOT part of this foundation

- **No allowlist/domain restriction on who can sign in.** Per the resolved
  decision ("supabase auth magic-link should be enough", CLAUDE.md), any
  email address can request a code and become an "author" able to publish
  scenarios facilitators will trust and run live. There's no separate
  `role` claim - "authenticated" IS "author" here. If that turns out to be
  too permissive for a real deployment, the fix is a Postgres auth hook or a
  domain check in the `insert`/`update` policies in `schema.sql`, not a
  schema rewrite.
- **Facilitator role still has no login of any kind** - by design. The
  Console's new "Cloud" scenario browser reads `published = true` rows
  through the anon/publishable key with no session at all, exactly matching
  how the Console already works today.

## Phase 9: Cross-device real-time sessions

Adds real-time session infrastructure on top of the foundation above -
`schema-sessions.sql`, `sync/cloudSession.js`, and a new Cloud transport arm
inside `sync/deviceSync.js`'s `createDeviceSync()`. **Feature-flagged and
additive**, per the explicit rollout decision made before building this:
the existing BroadcastChannel (same-machine, always-on) and WebSocket relay
(cross-device, opt-in, on Render) both keep working completely unchanged.
Nothing in this phase runs unless a facilitator clicks "Start Cloud
Session" in the Console, or a device is opened via a link carrying
`?session=`.

### To apply (two dashboard steps, once)

1. **Run the schema.** Paste `supabase/schema-sessions.sql` into the SQL
   Editor (same place `schema.sql` was applied) and run it. Idempotent -
   safe to re-run.
2. **Enable Anonymous Sign-ins.** Dashboard → Authentication → Providers →
   turn on "Anonymous Sign-Ins". This does NOT add a login screen anywhere -
   facilitators and learners still see none. It gives each browser tab a
   stable `auth.uid()` so Postgres Row Level Security can actually tell "a
   facilitator of THIS session" apart from "anyone who has the code" -
   which the pre-Phase-9 relay genuinely could not do (see the audit's own
   §5 finding: "anyone with the URL and the 6-character code can join and
   inject state"). It's unrelated to the Scenario Builder's separate
   email+OTP author login in `schema.sql`.

### What it adds

- **Session codes + QR joining.** "Start Cloud Session" in the Console
  generates a 6-character code (same alphabet/generator as the relay's
  codes) and renders a real QR code (`sync/qr.js` - a dependency-free
  encoder found already built inside the pacemaker sim for its own relay
  pairing, extracted here rather than reinventing one) pointing at the
  homepage with `?session=` attached. The homepage propagates that param
  onto every launch card, so a learner who scans it picks their device from
  the same launcher a facilitator would use.
- **Role-gated writes, enforced server-side.** `session_participants` holds
  each anonymous user's role (`facilitator` | `learner`) per session.
  `session_snapshots` RLS lets a learner write the `assessments` channel
  (matches Phase 8's existing "a learner's own tap writes shared state"
  model) but never `physiology` or `pacer_control` - a genuine, tested
  security boundary, not just a UI that doesn't offer the control. See
  `sync/cloudSessionLogic.js`'s `canWriteChannel()` for the client-side
  mirror used for local UI gating (not itself the security boundary - RLS
  is).
- **Full-state hydration on reconnect.** `session_snapshots.data` is a
  durable row per (session, channel), written every ~3s from whichever
  device is driving. A refreshing/reconnecting device does one `SELECT`
  against it on join - real state recovery, not the old relay's "wait for
  the next 600ms heartbeat and hope" (audit §5).
- **Pause / hidden resume snapshot.** The Console's Pause button freezes
  broadcasting on every transport at once (`createDeviceSync`'s new
  `pause()`/`resume()`, gated by `shouldBroadcast()`) - same-machine devices
  freeze too, not just cloud-connected ones. While paused, "Prepare Next
  State" stages the facilitator's in-progress navigation into
  `session_snapshots.pending_data` (a column no learner-facing UI ever
  reads); "Resume & Publish" copies it into the visible `data` column and
  un-freezes broadcasting in one step.
- **Pacemaker migration.** The pacemaker's own pre-existing
  dashboard↔learner control-panel pairing (its own `BroadcastChannel
  ('sim5392')`/relay code, entirely separate from the physiology bridge)
  now ALSO accepts a Cloud Session join for its `pacer_control` channel,
  and its `applyRemote()` gained an explicit shape guard
  (`isPacerControlShape()`) instead of relying on loose truthy checks -
  this is the actual fix for the audit's long-flagged "two incompatible
  sync systems coexist in the same relay room... working by luck, not a
  guarantee" gap (§2, §12). Deliberately NOT a full rewrite of that file's
  transport internals onto `sync/deviceSync.js` - see CLAUDE.md's Phase 9
  section for why a lower-risk, additive approach was chosen for this one
  real-hardware-matching file specifically, unlike the other three device
  pages (which import `sync/deviceSync.js` directly, unchanged).

### What's honestly still open

- **Never verified against real separate hardware.** Every check this
  phase got was multiple browser tabs on one machine standing in for
  "devices" - genuinely the best available in this environment, but not the
  same as a real second laptop + tablet. The audit's own risk note called
  this out explicitly ("stage it behind a feature flag... until the
  Supabase path is independently verified with a real second physical
  device") - that verification is still the user's to do, whenever
  convenient, not claimed as done here.
- **No session cleanup job.** A `sessions` row has `ended_at`, but nothing
  currently sets it - an old session's code just sits inert once nobody's
  pushing to it. Fine at this scale (a single sim lab), worth a scheduled
  cleanup if this ever needs to outlive one class's worth of sessions.
