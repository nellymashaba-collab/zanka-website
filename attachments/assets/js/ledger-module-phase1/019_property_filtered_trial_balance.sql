-- ============================================================================
-- ZANKA LEDGER MODULE — PHASE 2
-- 019_property_filtered_trial_balance.sql
--
-- Adds an optional property filter to get_period_trial_balance. Explicitly
-- DROPPING the old single-argument version first — CREATE OR REPLACE cannot
-- add a parameter without changing the function's signature, and doing that
-- without a DROP creates a second overloaded function instead of replacing
-- it (the exact class of bug that bit create_journal_entry earlier).
-- ============================================================================

drop function if exists public.get_period_trial_balance(uuid);

create or replace function public.get_period_trial_balance(p_period_id uuid, p_property_id bigint default null)
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
    where je.status = 'Posted'
      and je.period_id = p_period_id
      and (p_property_id is null or jl.property_id = p_property_id)
  ) activity on activity.account_code = coa.account_code
  group by coa.account_code, coa.account_name, coa.account_type, coa.normal_balance
  order by coa.account_code;
$$;

comment on function public.get_period_trial_balance is
  'Per-account debit/credit totals for Posted journals within a single accounting period. Pass p_property_id to scope to one property; omit (or pass null) for the whole portfolio.';

grant execute on function public.get_period_trial_balance(uuid, bigint) to authenticated;
