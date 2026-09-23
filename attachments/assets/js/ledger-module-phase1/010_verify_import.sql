-- ============================================================================
-- ZANKA LEDGER MODULE — PHASE 1
-- 010_verify_import.sql
--
-- Run this after 009. It checks four separate things — row counts, overall
-- balance, that every staged line actually got imported, and (strongest
-- check) that every account's total in the new ledger matches the TOTAL
-- column from your own "Trial Balance" sheet in Zanka Financials 3.xlsx.
-- If check 4 passes for every account, the import faithfully reproduces
-- your spreadsheet's numbers, not just "some numbers that balance."
-- ============================================================================

-- ---------------------------------------------------------------------------
-- CHECK 1: row counts. Expect 359 staged lines, all imported, across 45
-- journals (49 original journal numbers, 4 pairs merged into 4).
-- ---------------------------------------------------------------------------
select
  'CHECK 1: row counts' as check_name,
  count(*) as staged_lines,
  count(*) filter (where imported) as imported_lines,
  count(distinct journal_number) as distinct_journals,
  case
    when count(*) = 359
     and count(*) filter (where imported) = 359
     and count(distinct journal_number) = 45
    then 'PASS'
    else 'FAIL'
  end as result
from public.stg_legacy_transactions;

-- ---------------------------------------------------------------------------
-- CHECK 2: overall trial balance ties out (debits = credits across the
-- whole ledger, not just within each journal).
-- ---------------------------------------------------------------------------
select
  'CHECK 2: trial balance' as check_name,
  total_debits,
  total_credits,
  difference,
  case when is_balanced then 'PASS' else 'FAIL' end as result
from public.v_trial_balance_check;

-- ---------------------------------------------------------------------------
-- CHECK 3: every journal_entries row created by the import is Posted (none
-- stuck in Draft, which would mean it didn't go through validation properly).
-- ---------------------------------------------------------------------------
select
  'CHECK 3: journal status' as check_name,
  count(*) as total_imported_journals,
  count(*) filter (where status = 'Posted') as posted,
  count(*) filter (where status <> 'Posted') as not_posted,
  case when count(*) filter (where status <> 'Posted') = 0 then 'PASS' else 'FAIL' end as result
from public.journal_entries
where source_table = 'stg_legacy_transactions';

-- ---------------------------------------------------------------------------
-- CHECK 4: account-by-account comparison against your spreadsheet's own
-- Trial Balance sheet (TOTAL column, Oct 2025–Jun 2026). This is hardcoded
-- from that sheet, not recalculated — it's the independent source of truth.
--
-- Sign convention: your sheet's TOTAL is "Signed" (Dr=+, Cr=-). This query
-- converts v_account_balances.balance (always shown positive-natural) to
-- the same signed convention before comparing, so a PASS here means the
-- new ledger and your spreadsheet agree to the cent.
-- ---------------------------------------------------------------------------
with expected (account_code, expected_total) as (
  values
    (1000, -47.50), (1100, 0), (1150, 8000), (1200, 0), (1300, 0), (1400, 0),
    (1500, 537986.25), (1550, 71187), (1600, -1875), (1700, 0), (1800, 6122),
    (2000, -21302.43), (2100, -17500), (2200, 0), (2250, 0), (2300, -458837.35),
    (2400, 1801), (2500, -31421.63),
    (3000, -162363.71), (3100, 0),
    (4000, 0), (4100, 0), (4200, 0),
    (5000, 0), (5100, 0), (5200, 0),
    (6000, 14661), (6100, 0), (6200, 1000), (6300, 14708.81), (6350, -12012.76),
    (6400, 21493.62), (6500, 200), (6600, 11500), (6700, 0), (6800, 1251.51),
    (7000, 1655), (7050, 0), (7100, 9219.61), (7200, 0), (7300, 1875),
    (7400, 1847.86), (7500, 851.72)
),
actual as (
  select
    account_code,
    case when normal_balance = 'D' then balance else -balance end as signed_balance
  from public.v_account_balances
)
select
  'CHECK 4: ' || coa.account_code || ' ' || coa.account_name as check_name,
  e.expected_total,
  round(coalesce(a.signed_balance, 0), 2) as actual_total,
  round(coalesce(a.signed_balance, 0) - e.expected_total, 2) as difference,
  case when round(coalesce(a.signed_balance, 0) - e.expected_total, 2) = 0 then 'PASS' else 'FAIL' end as result
from expected e
join public.chart_of_accounts coa on coa.account_code = e.account_code
left join actual a on a.account_code = e.account_code
order by coa.account_code;

-- ---------------------------------------------------------------------------
-- SUMMARY: run this last for a one-line answer.
-- ---------------------------------------------------------------------------
select
  case
    when (select count(*) from public.stg_legacy_transactions) = 359
     and (select count(*) filter (where imported) from public.stg_legacy_transactions) = 359
     and (select is_balanced from public.v_trial_balance_check)
     and not exists (
       select 1 from public.journal_entries
       where source_table = 'stg_legacy_transactions' and status <> 'Posted'
     )
    then '✅ Import verified successful — row counts, balance, and journal status all check out. Now review CHECK 4 above account-by-account.'
    else '❌ Something failed — scroll up to find which check.'
  end as overall_result;
