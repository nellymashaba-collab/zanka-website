# KYC / Tenant Screening Module — Deployment Guide

This covers everything needed to take the KYC module from code in the repo to running in production: the database migration, the seven Edge Functions, secrets, storage, and how to verify it all worked. Read it top to bottom once before running anything — steps 1 and 2 must happen in order, before step 3.

## 1. Run the database migration

In the Supabase SQL Editor, run `022_kyc_module.sql` in full, followed by `022b_kyc_rls_tests.sql` (read-only checks — see that file's own instructions for how to step through it).

Before running 022, confirm `is_admin()` already exists in your database:

```sql
select proname from pg_proc where proname = 'is_admin';
```

If that returns no rows, stop — the whole module's RLS depends on it, and 022 does not create it (it's assumed to already exist from earlier work on this platform).

022 is written to be safe to re-run (`create table if not exists`, `drop policy if exists` before every `create policy`), so if a run fails partway through, fix the error and re-run the whole file rather than trying to resume from the middle.

What 022 creates: `compliance_settings` (one seeded row), `kyc_cases`, `kyc_checks`, `kyc_documents`, `kyc_consents`, `kyc_risk_assessments`, `kyc_reviews`, `kyc_audit_log`, `property_manager_assignments`, RLS on all of them, column-level GRANT/REVOKE lockdown on the sensitive columns, the private `kyc-documents` storage bucket and its policies, and the triggers that sync a case's outcome into `leases.fica_status`.

It also extends `documents_category_check` to allow the new KYC-related document categories — check for constraint conflicts if you've modified that constraint again since the Levy Statement fix earlier in this project.

## 2. Set secrets

These are Supabase project secrets (Project Settings → Edge Functions → Secrets, or via the CLI). `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are already provided automatically to every Edge Function — do not set them yourself.

The one secret this module needs that isn't automatic:

```
KYC_WEBHOOK_SECRET
```

Generate a random value for it — e.g. `openssl rand -hex 32` in any terminal — and set it via:

```
supabase secrets set KYC_WEBHOOK_SECRET=<the value you generated>
```

This is the shared secret used to verify the HMAC signature on inbound webhook calls to `kyc-provider-webhook`. Because the current provider is the built-in `PlaceholderProvider` (simulated, synchronous — see `_shared/kyc-provider.ts`), nothing calls this webhook yet in practice. Set the secret now anyway so it's in place the day a real provider is wired in.

When a real provider (Smile ID, Trulioo, TransUnion, XDS, Compuscan, ComplyAdvantage, etc.) is contracted, it will supply its own API key — add that as a new secret (e.g. `KYC_PROVIDER_API_KEY`) and implement a new class in `_shared/kyc-provider.ts` alongside `PlaceholderProvider`, then flip `compliance_settings.provider` to select it. No schema or Edge Function changes should be needed beyond that new class.

## 3. Deploy the Edge Functions

Unlike the single-file `dms-notifications` function (deployable by pasting into the Supabase Dashboard's code editor), these seven functions share a `_shared/` folder via relative imports. The Dashboard's editor can't handle that — you need the Supabase CLI.

One-time setup (skip anything you've already done):

```bash
npm install -g supabase
supabase login
supabase link --project-ref blhjlsddmwxjchjlfnhk
```

(`blhjlsddmwxjchjlfnhk` is the live `zanka-group` project confirmed earlier in this engagement — not the unused duplicate that was deleted.)

Then, from the repo root (with the `supabase/functions/` folder in place, including `_shared/`), deploy each function:

```bash
supabase functions deploy kyc-create-case
supabase functions deploy kyc-start-check
supabase functions deploy kyc-get-status
supabase functions deploy kyc-request-document
supabase functions deploy kyc-complete-review
supabase functions deploy kyc-risk-assessment
supabase functions deploy kyc-provider-webhook --no-verify-jwt
```

`kyc-provider-webhook` is the only one deployed with `--no-verify-jwt` — it's called by an external provider, not by a logged-in user, so it can't present a Supabase auth JWT. It authenticates itself instead via the HMAC signature checked against `KYC_WEBHOOK_SECRET`.

If your local machine has no git/CLI tooling set up (this project has mostly used manual GitHub web uploads and the Supabase Dashboard so far), this is the one part of this module that requires installing Node.js and the Supabase CLI locally, or using a machine/CI runner that has them — there's no Dashboard-only path for multi-file functions.

## 4. Verify

- Run `022b_kyc_rls_tests.sql` per its own instructions — confirms tenant/owner/admin/anon all see exactly what they should and nothing else.
- From a test tenant account with a Draft lease, open the tenant dashboard and confirm the "Verify Your Identity" card appears, consent checkboxes work, and clicking Start Verification calls `kyc-create-case` then `kyc-start-check` without error (check the browser console/network tab).
- From the admin dashboard, open Compliance → KYC Applications and confirm the test case appears; open its detail view and confirm checks/documents/risk render.
- Try Approve, Decline (should require a reason), Request Information, and Override & Approve (should require a reason and produce a `KYC_OVERRIDE` audit event) — check the Audit Log tab after each.
- From the test owner account (oshabangu@gmail.com on the test property), confirm the Tenant Screening card on the owner dashboard shows the restricted summary (Identity/Screening/Affordability/Risk/Recommendation) with no raw scores, notes, or documents.
- Confirm `leases.fica_status` on the test lease flips in sync with the KYC case status (query `select id, fica_status from leases where id = <test lease id>`).

## 5. Files this module touches

Database: `022_kyc_module.sql`, `022b_kyc_rls_tests.sql` (both in `ledger-module-phase1/`).

Edge Functions (all under `supabase/functions/`): `_shared/cors.ts`, `_shared/kyc-provider.ts`, `_shared/kyc-engine.ts`, `kyc-create-case/index.ts`, `kyc-start-check/index.ts`, `kyc-provider-webhook/index.ts`, `kyc-get-status/index.ts`, `kyc-request-document/index.ts`, `kyc-complete-review/index.ts`, `kyc-risk-assessment/index.ts`.

Frontend: `tenant-dashboard.html` / `assets/js/tenant-dashboard.js` (KYC status widget, consent flow, document upload), `assets/js/lease-manager.js` (auto-creates a `kyc_cases` row when a Draft lease is created), `admin-dashboard.html` / `assets/js/admin-dashboard.js` (Compliance nav section: applications, documents, audit log, settings), `owner-dashboard.html` / `assets/js/owner-dashboard.js` (restricted Tenant Screening summary card).

## 6. Not done here — needs a human decision, not more code

- **Retention periods.** `compliance_settings.document_retention_period_days`, `kyc_record_retention_period_days`, and `audit_log_retention_period_days` are deliberately left `null`. Do not fill these in from a guess — get Zanka's actual data retention requirements from a legal/privacy review (POPIA in South Africa is the relevant framework) and set them via the admin Compliance → Settings screen once known. Nothing currently auto-deletes anything based on these values; enforcing them (a scheduled cleanup job) is a separate, deliberately unbuilt piece of work that should wait until the numbers are real.
- **Choosing a real KYC/credit provider.** The module ships with only `PlaceholderProvider` — a deterministic simulation, clearly tagged `simulated: true` in every stored result, that lets the whole flow be tested end-to-end without a live contract. No production KYC decision should ever be made on placeholder data. Contracting a real provider is a business/legal decision (pricing, SLA, POPIA-compliant data processing agreement), not something to resolve in code.
- **The `property_manager` role.** `property_manager_assignments` and `is_property_manager()` exist in the schema and RLS is written to respect them, but this platform has no actual `property_manager` role/login flow today — this is forward-compatibility only. If Zanka never introduces that role, this code is inert and harmless; if it does, KYC access for that role already works without further schema changes.
- **Automated (non-SQL-editor) RLS test suite.** `022b_kyc_rls_tests.sql` is a manual, step-through script for the SQL Editor because this environment has no `psql`/CLI access to the live database and no Deno/TypeScript toolchain available (network-restricted sandbox — confirmed while building this module). If real CI is set up later, this script is a reasonable starting point for a proper automated pgTAP or scripted-`psql` test.
