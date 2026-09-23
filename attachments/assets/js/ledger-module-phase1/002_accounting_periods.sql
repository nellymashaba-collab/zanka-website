-- ============================================================================
-- ZANKA LEDGER MODULE — PHASE 1
-- 002_accounting_periods.sql
--
-- Accounting periods (spec section 35). Journals can only post into an
-- Open period. Closed periods are protected — corrections after close must
-- use a reversal/adjustment journal in a later open period, never an edit.
-- ============================================================================

create table if not exists public.accounting_periods (
  id           uuid primary key default gen_random_uuid(),
  period_start date not null,
  period_end   date not null,
  status       text not null default 'Open' check (status in ('Open','Closed','Reopened')),
  closed_by    uuid references public.profiles(id),
  closed_at    timestamptz,
  reopened_by  uuid references public.profiles(id),
  reopened_at  timestamptz,
  created_at   timestamptz not null default now(),
  constraint period_valid_range check (period_end >= period_start),
  constraint period_unique_range unique (period_start, period_end)
);

comment on table public.accounting_periods is
  'Monthly (or custom-range) accounting periods. Journals reference a period_id and cannot post into a Closed period.';

-- Seed periods matching your existing model range (Oct 2025 – Jun 2026 per
-- the Setup sheet), as calendar months, all Open by default. Extend as needed.
insert into public.accounting_periods (period_start, period_end)
select
  d::date as period_start,
  (d + interval '1 month - 1 day')::date as period_end
from generate_series('2025-10-01'::date, '2026-06-01'::date, interval '1 month') as d
on conflict (period_start, period_end) do nothing;

-- Helper: find the open period a given date falls into (used by the posting
-- function in 004_gl_functions.sql). Returns null if no open period covers
-- the date, which the posting function treats as a hard error.
create or replace function public.find_period_for_date(p_date date)
returns uuid
language sql
stable
as $$
  select id
  from public.accounting_periods
  where p_date between period_start and period_end
  order by period_start desc
  limit 1;
$$;
