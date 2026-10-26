# Tenant Recruitment Module — deployment

Adds everything that happens **before** a Draft lease exists: vacancy → public application → POPIA consent → document upload → screening (knockouts + 100-point score) → offer → acceptance → hand-over to the existing Lease Wizard. The lease, KYC and inspection modules are unchanged; the Lease Wizard just gains a pre-fill.

## Files

| File | What it is |
|---|---|
| `024_tenant_recruitment.sql` | Tables, RLS, public functions, private `rental-applications` bucket |
| `apply.html` + `assets/js/apply.js` | Public page: open units, 6-step application, consent, uploads. No account needed. |
| `tenant-recruitment.html` + `assets/js/tenant-recruitment.js` | Admin: vacancies, applicant list, verify and score, offer/decline, hand-over, settings, document retention |
| `assets/js/recruitment-scoring.js` | Scoring engine (pure functions, thresholds read from settings) |
| `assets/js/lease-manager.js` (changed) | `lease-wizard.html?application=<id>` pre-fills property, tenant, rent, deposit, dates; saving the lease links it back and marks the vacancy Let |
| `admin-dashboard.html` (changed) | "Tenant Recruitment" sidebar link |
| `assets/css/style.css` (changed) | One line: `.btn.hidden{display:none}` |
| `sitemap.xml` (changed) | Adds `apply.html` |

## Run order

1. In the Supabase SQL editor, on a **branch or staging project first**:
   ```sql
   select proname from pg_proc where proname = 'is_admin';   -- must return one row
   ```
   then run `024_tenant_recruitment.sql`. It is safe to re-run.
2. Check the bucket exists: Storage → `rental-applications` (private, 10 MB limit).
3. Deploy the site files.
4. Log in as admin → Tenant Recruitment → **Screening settings**. The thresholds are the draft values from the recruitment pack. Once your property practitioner confirms them, tick "confirmed" so the warning banner disappears.
5. Create a vacancy, set it to **Open**, and use "Copy apply link".

## How it was tested

- The migration was executed on a real Postgres (PGlite) with stand-ins for `profiles`, `properties`, `leases`, `is_admin()`, `auth.uid()` and the storage schema: 31 checks, including that anonymous users cannot read any recruitment table or token, can upload only into their own in-progress folder, cannot upload after submitting, and that required documents are enforced.
- The scoring engine: 14 unit checks (band boundaries, knockouts, contract and tenure maths, settings overrides).
- The full flow was driven in headless Chrome against a mocked backend: 50 checks covering vacancy creation, the 6-step application, upload retry, admin scoring, offer/decline emails, the tenant-account hand-over, Lease Wizard pre-fill and link-back, phone-width layout, and that HTML typed by an applicant is never executed in the admin page.
- **Not yet tested against your live Supabase project.** In particular, Supabase Storage's own checks on anonymous uploads should be confirmed on staging with one real test application.

## Listing photos (025)

`025_listing_photos.sql` adds photos to vacancies. Run it in the SQL editor after 024. It is safe to re-run; if you ever re-run 024, run 025 again afterwards.

- Photos live in a **public** bucket, `listing-photos`, because anyone viewing a listing should see them. Only admins can upload, replace or delete. Applicants' documents remain in the separate private bucket.
- In the vacancy form: add up to 20 photos, reorder by dragging or with the arrows, choose a cover, remove. Photos are shrunk in the browser to 1600px on the long side (about 200–400 KB) before upload, so listings load quickly on mobile data.
- Photos added and then abandoned (form closed without saving) are deleted. Photos removed from a listing are deleted when the listing is saved.
- Public page: the cover photo on each card, a swipeable gallery with arrows, thumbnails and keyboard support on the unit page.

## Automatic emails (026 + rental-notifications)

Every listing and application change that someone should hear about is emailed automatically, with the admin address cc'd on every email.

| What happened | Who is emailed |
|---|---|
| Listing created; goes live, closed, let or unpublished | Owner |
| Listing title, rent, deposit, available date or closing date changed | Owner (quick successive edits become one email) |
| Application submitted | Applicant (confirmation + reference) and owner |
| Offer made | Applicant (offer letter with 48-hour deadline) and owner |
| Offer accepted | Owner |
| Application declined | Applicant |
| "Email account invitation" clicked | Applicant |

Owners never receive applicants' names, contact details, ID numbers or references: the POPIA consent applicants sign covers Zanka Group and its agents, not owners. The internal decline reason is never sent to the applicant. Replies go to the admin address.

If a property has no owner on file, the owner email goes to the admin address with a note.

### Setup

1. Run `026_rental_notifications.sql` in the SQL editor (after 024 and 025). Safe to re-run.
2. Deploy the function: Supabase dashboard → **Edge Functions** → **Deploy a new function** → **Via editor**. Name it exactly `rental-notifications`, paste in `supabase/functions/rental-notifications/index.ts`, and deploy. (CLI: `supabase functions deploy rental-notifications`.)
3. Nothing else: it uses the same `RESEND_API_KEY` secret and verified sender (`notifications@zankagroup.co.za`) as `dms-notifications`.
4. In Tenant Recruitment → **Screening settings → Automatic emails**, check the admin address.

### How delivery is guaranteed

Changes are written to a queue table (`rental_notifications`) by database triggers, in the same transaction as the change, so no event can be lost whichever page made it. The website then calls the function to send whatever is waiting. If that call fails or the browser closes, the email waits and goes out the next time anything calls the function (every admin page load does). Failed sends are retried automatically up to 3 times; the **Emails** panel shows every email, who it went to, and any error, with a **Retry** button.

Optional backup: to send waiting emails even when nobody opens the admin page, schedule the function every 5 minutes (Supabase dashboard → Integrations → Cron → new job → "Supabase Edge Function" → `rental-notifications`, POST, empty body).

## Design decisions worth knowing

- **Separate `rental_*` tables.** The existing `applications`, `listings` and `viewings` tables belong to the estate-agent partner workspace; they were left alone.
- **Applicants never touch tables.** Every public action goes through a `SECURITY DEFINER` function. Upload tokens live in a table with no policies, so no client role can read one.
- **Public listings never show the property address.** The vacancy has its own public title and area; the admin form warns if a title looks like it contains a unit number.
- **Emails open in your mail app** (offer, decline, account invitation), pre-written from the pack templates, so you review before sending. No new Edge Function was added.
- **Self-employed, 2+ years** scores half marks for employment stability. The pack only defines "under 2 years = zero", so this is an assumption to confirm with your practitioner.
- **Retention:** the consent promises declined applicants' documents are destroyed within 90 days. Settings → "Delete expired documents" does this (files and document rows; the application and consent records are kept as evidence of a fair decision).
- **Abuse limits:** one live application per ID number per unit, and at most 5 applications per email per day. There is no CAPTCHA; add one if spam appears.
