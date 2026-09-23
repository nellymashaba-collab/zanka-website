-- ============================================================================
-- ZANKA LEDGER MODULE — PHASE 2
-- 013_extend_accounting_periods.sql
--
-- Phase 1 only seeded periods through Jun 2026. Any invoice/payment posted
-- from Jul 2026 onward has no Open period to land in and create_journal_entry()
-- will reject it — so this must run before 011/012 go live in production.
--
-- Extends monthly periods through Dec 2027. Re-run periodically (or build
-- an admin "open next period" action in a later phase) to keep it topped up.
-- ============================================================================

insert into public.accounting_periods (period_start, period_end)
select
  d::date as period_start,
  (d + interval '1 month - 1 day')::date as period_end
from generate_series('2026-07-01'::date, '2027-12-01'::date, interval '1 month') as d
on conflict (period_start, period_end) do nothing;
