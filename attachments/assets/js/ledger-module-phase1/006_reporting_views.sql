-- ============================================================================
-- ZANKA LEDGER MODULE — PHASE 1
-- 006_reporting_views.sql
--
-- Trial balance and account balance views, computed live from Posted
-- journal_lines only. This is the Phase 1 proof that the engine works:
-- if these numbers don't tie out, something upstream is broken.
-- ============================================================================

create or replace view public.v_account_balances as
select
  coa.account_code,
  coa.account_name,
  coa.account_type,
  coa.normal_balance,
  coa.statement,
  coalesce(sum(jl.amount) filter (where jl.dr_cr = 'D'), 0) as total_debits,
  coalesce(sum(jl.amount) filter (where jl.dr_cr = 'C'), 0) as total_credits,
  case coa.normal_balance
    when 'D' then coalesce(sum(jl.amount) filter (where jl.dr_cr = 'D'), 0)
                  - coalesce(sum(jl.amount) filter (where jl.dr_cr = 'C'), 0)
    else coalesce(sum(jl.amount) filter (where jl.dr_cr = 'C'), 0)
                  - coalesce(sum(jl.amount) filter (where jl.dr_cr = 'D'), 0)
  end as balance
from public.chart_of_accounts coa
left join public.journal_lines jl on jl.account_code = coa.account_code
left join public.journal_entries je on je.id = jl.journal_entry_id and je.status = 'Posted'
where coa.is_active
group by coa.account_code, coa.account_name, coa.account_type, coa.normal_balance, coa.statement
order by coa.account_code;

comment on view public.v_account_balances is
  'One row per account with lifetime totals and balance, Posted journals only. Basis for the trial balance below and for P&L/Balance Sheet views in a later phase.';

create or replace view public.v_trial_balance as
select
  account_code,
  account_name,
  account_type,
  case when normal_balance = 'D' and balance >= 0 then balance
       when normal_balance = 'C' and balance < 0 then abs(balance)
       else 0 end as debit,
  case when normal_balance = 'C' and balance >= 0 then balance
       when normal_balance = 'D' and balance < 0 then abs(balance)
       else 0 end as credit
from public.v_account_balances
order by account_code;

comment on view public.v_trial_balance is
  'Classic trial balance layout. sum(debit) should equal sum(credit) exactly — see v_trial_balance_check.';

create or replace view public.v_trial_balance_check as
select
  round(sum(debit), 2) as total_debits,
  round(sum(credit), 2) as total_credits,
  round(sum(debit) - sum(credit), 2) as difference,
  (round(sum(debit), 2) = round(sum(credit), 2)) as is_balanced
from public.v_trial_balance;

comment on view public.v_trial_balance_check is
  'Single-row sanity check. is_balanced must always be true — if not, something bypassed create_journal_entry() or a bug exists in these views.';

-- Property-level P&L is the natural "does this actually work" test, since
-- it's the number your spreadsheet's Property Register/Dashboard already
-- reports. Kept minimal in Phase 1 — full property income statement with
-- NOI/financing split comes in a later phase per spec section 21.
create or replace view public.v_property_account_summary as
select
  jl.property_id,
  coa.account_code,
  coa.account_name,
  coa.account_type,
  coalesce(sum(jl.amount) filter (where jl.dr_cr = 'D'), 0) as total_debits,
  coalesce(sum(jl.amount) filter (where jl.dr_cr = 'C'), 0) as total_credits
from public.journal_lines jl
join public.journal_entries je on je.id = jl.journal_entry_id and je.status = 'Posted'
join public.chart_of_accounts coa on coa.account_code = jl.account_code
where jl.property_id is not null
group by jl.property_id, coa.account_code, coa.account_name, coa.account_type
order by jl.property_id, coa.account_code;
