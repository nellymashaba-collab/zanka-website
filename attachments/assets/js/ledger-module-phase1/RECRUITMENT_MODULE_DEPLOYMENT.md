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

## Design decisions worth knowing

- **Separate `rental_*` tables.** The existing `applications`, `listings` and `viewings` tables belong to the estate-agent partner workspace; they were left alone.
- **Applicants never touch tables.** Every public action goes through a `SECURITY DEFINER` function. Upload tokens live in a table with no policies, so no client role can read one.
- **Public listings never show the property address.** The vacancy has its own public title and area; the admin form warns if a title looks like it contains a unit number.
- **Emails open in your mail app** (offer, decline, account invitation), pre-written from the pack templates, so you review before sending. No new Edge Function was added.
- **Self-employed, 2+ years** scores half marks for employment stability. The pack only defines "under 2 years = zero", so this is an assumption to confirm with your practitioner.
- **Retention:** the consent promises declined applicants' documents are destroyed within 90 days. Settings → "Delete expired documents" does this (files and document rows; the application and consent records are kept as evidence of a fair decision).
- **Abuse limits:** one live application per ID number per unit, and at most 5 applications per email per day. There is no CAPTCHA; add one if spam appears.
