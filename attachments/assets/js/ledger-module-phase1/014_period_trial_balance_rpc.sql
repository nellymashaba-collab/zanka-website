-- ============================================================================
-- ZANKA LEDGER MODULE — PHASE 2
-- 014_period_trial_balance_rpc.sql
--
-- v_trial_balance (Phase 1) is lifetime-to-date — it answers "what's the
-- balance of this account right now." For a period export ("give me
-- November's numbers") that's the wrong question; this function answers
-- "what moved through this account during period X only."
--
-- Called directly from the admin dashboard's Reports export.
-- ============================================================================

create or replace function public.get_period_trial_balance(p_period_id uuid)
returns table(
  account_code    integer,
  account_name    text,
  account_type    text,
  normal_balance  text,
  debit           numeric,
  credit          numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    coa.account_code,
    coa.account_name,
    coa.account_type,
    coa.normal_balance,
    coalesce(sum(activity.amount) filter (where activity.dr_cr = 'D'), 0) as debit,
    coalesce(sum(activity.amount) filter (where activity.dr_cr = 'C'), 0) as credit
  from public.chart_of_accounts coa
  left join (
    select jl.account_code, jl.dr_cr, jl.amount
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.journal_entry_id
    where je.status = 'Posted' and je.period_id = p_period_id
  ) activity on activity.account_code = coa.account_code
  group by coa.account_code, coa.account_name, coa.account_type, coa.normal_balance
  order by coa.account_code;
$$;

comment on function public.get_period_trial_balance is
  'Per-account debit/credit totals for Posted journals within a single accounting period only (not cumulative). Used by the admin dashboard Excel export.';

grant execute on function public.get_period_trial_balance(uuid) to authenticated;
