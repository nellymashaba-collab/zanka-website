-- ============================================================================
-- ZANKA LEDGER MODULE — PHASE 2
-- 015_payments_update_policy.sql
--
-- `payments` has RLS enabled with SELECT and INSERT policies, but no UPDATE
-- policy at all — for any role. This predates the ledger module; the only
-- existing feature was inserting a new payment (invoice generation), never
-- updating one, so nobody needed it until now.
--
-- Effect without this: every UPDATE from the browser (admin or otherwise)
-- silently matches 0 rows. PostgREST still returns "204 success" by default
-- (supabase-js doesn't ask for return=representation), so the app has no way
-- to tell the write did nothing — it just quietly never happens. The "Mark
-- as Paid (EFT)" button hit exactly this: 204 back, UI looked fine, row
-- never actually changed, so the posting trigger never fired either.
-- ============================================================================

create policy "Admins can update payments" on public.payments
  for update
  using (is_admin())
  with check (is_admin());
