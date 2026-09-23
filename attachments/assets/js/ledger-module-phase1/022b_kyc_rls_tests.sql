-- ============================================================================
-- 022b_kyc_rls_tests.sql
-- Manual RLS verification for the KYC module (022_kyc_module.sql).
--
-- HOW TO USE
-- Run this in the Supabase SQL Editor, ONE NUMBERED BLOCK AT A TIME, in
-- order, reading the comment above each block for what you should see.
-- This is not a pass/fail script you run all at once — Supabase's SQL
-- editor keeps one session, and these blocks deliberately change which
-- "user" the session is acting as (via SET ROLE + a fake JWT claim), the
-- same mechanism PostgREST uses for every real request. Running block 0
-- once at the start and block 99 once at the end is required; everything
-- in between can be re-run/re-ordered as you like.
--
-- This script does not modify any KYC data. It only reads. It DOES
-- temporarily create one throwaway lease/case pair for testing if none
-- exists for the test property already, and cleans it up at the end
-- (block 99) — safe to run against production data.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- BLOCK 0 — find or create test fixtures
-- Uses the existing test property "Unit 5 Test Notification Property
-- Sandton 2196" (id 13 in earlier testing this engagement) and its tenant
-- Nelly Shabangu. Adjust the two ids below if your test data differs.
-- ----------------------------------------------------------------------------
select id as property_id, owner_id, address from public.properties where address ilike '%test notification%';
select id as tenant_id, full_name, email from public.profiles where email ilike '%nelly%';

-- Substitute the ids you got above into :test_property_id / :test_tenant_id
-- for the rest of this script (psql-style variables shown for clarity —
-- in the Supabase SQL editor, just replace the literal values by hand).

-- Find (or note you'll need to create) a Draft lease for that property/tenant:
select id as lease_id, status from public.leases
where property_id = 13 and tenant_id = (select id from public.profiles where email ilike '%nelly%' limit 1)
order by created_at desc limit 1;

-- If no lease exists yet, create one via the admin dashboard's "Link
-- Tenant to Property" flow first (kyc_cases.application_id is a hard
-- foreign key to leases.id — there's no way to test KYC RLS without a
-- real lease row to hang the case off).

-- ----------------------------------------------------------------------------
-- BLOCK 1 — confirm is_admin() exists (022's own pre-flight check)
-- EXPECT: one row, proname = 'is_admin'
-- ----------------------------------------------------------------------------
select proname from pg_proc where proname = 'is_admin';

-- ----------------------------------------------------------------------------
-- BLOCK 2 — confirm the KYC tables and RLS are actually enabled
-- EXPECT: all 7 tables listed, rowsecurity = true for every one
-- ----------------------------------------------------------------------------
select relname, relrowsecurity
from pg_class
where relname in ('kyc_cases','kyc_checks','kyc_documents','kyc_consents','kyc_risk_assessments','kyc_reviews','kyc_audit_log','compliance_settings')
order by relname;

-- ----------------------------------------------------------------------------
-- BLOCK 3 — column-level GRANT lockdown check
-- EXPECT: raw_response, provider, provider_reference should NOT appear in
-- this list for the 'authenticated' role (they're revoked). Everything
-- else on kyc_checks should appear.
-- ----------------------------------------------------------------------------
select column_name
from information_schema.column_privileges
where table_name = 'kyc_checks' and grantee = 'authenticated' and privilege_type = 'SELECT'
order by column_name;

-- ----------------------------------------------------------------------------
-- BLOCK 4 — simulate the TENANT and confirm they see only their own case
-- Replace the uuid below with the real tenant_id from Block 0.
-- EXPECT: the tenant's own case only (0 or 1 rows) — never another
-- tenant's case, even though this query has no WHERE clause on tenant_id.
-- ----------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000000000'::text, 'role', 'authenticated')::text, true);
-- ^ replace the zeros above with the real tenant profile id from Block 0
select id, tenant_id, status from public.kyc_cases;
reset role;

-- ----------------------------------------------------------------------------
-- BLOCK 5 — simulate the OWNER and confirm they get ZERO rows from a
-- direct table query — owners have no kyc_cases policy at all by design;
-- they can only reach curated data via the kyc-get-status Edge Function.
-- Replace the uuid below with the real owner profile id (oshabangu@gmail.com).
-- EXPECT: 0 rows.
-- ----------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'e3d19d66-4323-4ca4-adff-1da1afedbb74'::text, 'role', 'authenticated')::text, true);
select id, tenant_id, status from public.kyc_cases;
reset role;

-- ----------------------------------------------------------------------------
-- BLOCK 6 — simulate the ADMIN and confirm they see every case
-- Replace the uuid below with your own admin profile id.
-- EXPECT: every kyc_cases row in the system.
-- ----------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '<your-admin-profile-id>'::text, 'role', 'authenticated')::text, true);
select id, tenant_id, status from public.kyc_cases;
reset role;

-- ----------------------------------------------------------------------------
-- BLOCK 7 — confirm an UNAUTHENTICATED (anon) request sees nothing
-- EXPECT: 0 rows, or a permission-denied style error depending on grants.
-- ----------------------------------------------------------------------------
set local role anon;
select id, tenant_id, status from public.kyc_cases;
reset role;

-- ----------------------------------------------------------------------------
-- BLOCK 8 — kyc_documents storage RLS: confirm a tenant can only list
-- their own folder. Run this in the SQL editor as a sanity check of the
-- storage.objects policy shape (actual upload/download is easier to test
-- from the tenant dashboard UI directly than from SQL).
-- EXPECT: policy names below match "Tenants manage own kyc-documents"
-- and "Admins manage all kyc-documents" (or equivalent from 022's storage
-- section) — confirms the policies were actually created.
-- ----------------------------------------------------------------------------
select policyname, cmd, roles from pg_policies where tablename = 'objects' and schemaname = 'storage' and policyname ilike '%kyc%';

-- ----------------------------------------------------------------------------
-- BLOCK 9 — compliance_settings: confirm only admins can write
-- Run as the tenant (Block 4's role setup) — EXPECT: update affects 0 rows
-- or errors with a policy violation, never succeeds.
-- ----------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000000000'::text, 'role', 'authenticated')::text, true);
update public.compliance_settings set provider = 'should-not-work';
reset role;
-- Then re-check as admin (Block 6's setup) that provider is unchanged:
-- select provider from public.compliance_settings;

-- ----------------------------------------------------------------------------
-- BLOCK 99 — no cleanup needed
-- This script never inserted anything (only read + one deliberately-
-- expected-to-fail update attempt in Block 9), so there is nothing to
-- roll back. If you created a throwaway lease in Block 0 purely for
-- testing, delete it manually via the admin dashboard once done.
-- ----------------------------------------------------------------------------
