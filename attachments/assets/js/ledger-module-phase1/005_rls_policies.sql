-- ============================================================================
-- ZANKA LEDGER MODULE — PHASE 1
-- 005_rls_policies.sql
--
-- Confirmed: profiles.id (uuid, matches auth.uid()) and profiles.role exist.
-- These policies assume role values: 'admin','accountant','property_manager',
-- 'owner','tenant','partner'. If the actual stored values differ (e.g.
-- different casing, or 'manager' instead of 'property_manager'), the
-- policies below will silently match nobody rather than error — worth a
-- quick `select distinct role from profiles;` before relying on this in
-- production.
--
-- General ledger detail (journal_entries / journal_lines) is NOT exposed to
-- owners or tenants in Phase 1. They'll get scoped statements (spec
-- sections 22–24: owner sub-ledger, tenant sub-ledger) built as reporting
-- views in a later phase — those views compute from the GL but only ever
-- return that person's own numbers. Raw journal access stays staff-only.
-- ============================================================================

alter table public.chart_of_accounts enable row level security;
alter table public.accounting_periods enable row level security;
alter table public.journal_entries enable row level security;
alter table public.journal_lines enable row level security;

create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- chart_of_accounts — readable by any staff role; not writable via API
-- (changes to the chart of accounts go through migrations, not the app).
-- ---------------------------------------------------------------------------
create policy "coa_select_staff" on public.chart_of_accounts
  for select
  using (public.current_user_role() in ('admin','accountant','property_manager'));

-- ---------------------------------------------------------------------------
-- accounting_periods — readable by staff; opening/closing periods should go
-- through an admin-only function added in a later phase, not direct UPDATE.
-- ---------------------------------------------------------------------------
create policy "periods_select_staff" on public.accounting_periods
  for select
  using (public.current_user_role() in ('admin','accountant','property_manager'));

-- ---------------------------------------------------------------------------
-- journal_entries — admin/accountant see everything. property_manager sees
-- only journals with at least one line touching a property they're assigned
-- to (via partner_property_assignments, seen referenced in your existing
-- partner-dashboard.js — confirm this table's real columns before relying
-- on this policy).
-- ---------------------------------------------------------------------------
create policy "journal_entries_select_admin" on public.journal_entries
  for select
  using (public.current_user_role() in ('admin','accountant'));

create policy "journal_entries_select_property_manager" on public.journal_entries
  for select
  using (
    public.current_user_role() = 'property_manager'
    and exists (
      select 1
      from public.journal_lines jl
      join public.partner_property_assignments ppa
        on ppa.property_id = jl.property_id
      where jl.journal_entry_id = journal_entries.id
        and ppa.partner_id = auth.uid()
    )
  );

-- No insert/update/delete policies are defined for journal_entries or
-- journal_lines. All writes happen exclusively through create_journal_entry()
-- and reverse_journal_entry(), which run as SECURITY DEFINER and therefore
-- bypass RLS on the write path — while still being callable by any
-- authenticated staff member (grants below). This is the DB-level version
-- of spec section 51 ("no direct client-side journal posting").

create policy "journal_lines_select_admin" on public.journal_lines
  for select
  using (public.current_user_role() in ('admin','accountant'));

create policy "journal_lines_select_property_manager" on public.journal_lines
  for select
  using (
    public.current_user_role() = 'property_manager'
    and exists (
      select 1 from public.partner_property_assignments ppa
      where ppa.property_id = journal_lines.property_id
        and ppa.partner_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- Function execution grants — any authenticated user can call these, but
-- the functions themselves don't check role. Add a role check inside
-- create_journal_entry() before going live if you want to restrict who can
-- post (e.g. only admin/accountant/property_manager, not tenant/owner).
-- Flagging this rather than guessing your intended policy.
-- ---------------------------------------------------------------------------
grant execute on function public.create_journal_entry(date, text, text, text, text, uuid, jsonb, uuid) to authenticated;
grant execute on function public.reverse_journal_entry(uuid, text, date, uuid) to authenticated;
grant execute on function public.find_period_for_date(date) to authenticated;
grant execute on function public.current_user_role() to authenticated;
