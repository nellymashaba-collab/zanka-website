-- ============================================================================
-- ZANKA LEDGER MODULE — PHASE 3 (Fractional Units)
-- 021_fractional_units.sql
--
-- Adds "Unit Holder" fractional ownership — a new concept, deliberately
-- named apart from the existing "Investor" (investor_entities), which
-- means a company/trust that owns a whole property outright. A fractional
-- property's investor_entity_id points to its own SPV entity (per the
-- build spec's own SPV-per-property structure) — nothing about the
-- existing ownership constraint or get_effective_owner_id() changes.
--
-- BEFORE RUNNING: confirm 2700, 3100 and 3200 aren't already used in your
-- chart_of_accounts —
--   select account_code, account_name from public.chart_of_accounts
--   where account_code in (2700, 3100, 3200);
-- should return no rows. If any of these codes are taken, change the
-- three account_code values below (and the matching ones in the trigger
-- functions further down) before running.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Chart of accounts additions
-- ---------------------------------------------------------------------------

insert into public.chart_of_accounts (account_code, account_name, account_type, account_subtype, normal_balance, statement, notes)
select 3200, 'Unit Holder Capital', 'Equity', 'Rentals', 'C', 'BS', 'Added Phase 3 — capital contributed by fractional Unit Holders when units are purchased.'
where not exists (select 1 from public.chart_of_accounts where account_code = 3200);

insert into public.chart_of_accounts (account_code, account_name, account_type, account_subtype, normal_balance, statement, notes)
select 3100, 'Distributions Declared', 'Equity', 'Rentals', 'D', 'BS', 'Added Phase 3 — contra-equity, debited when a distribution run is declared against Unit Holder Capital.'
where not exists (select 1 from public.chart_of_accounts where account_code = 3100);

insert into public.chart_of_accounts (account_code, account_name, account_type, account_subtype, normal_balance, statement, notes)
select 2700, 'Distributions Payable', 'Liability', 'Rentals', 'C', 'BS', 'Added Phase 3 — owed to Unit Holders between a distribution run being declared and each payout being marked Paid.'
where not exists (select 1 from public.chart_of_accounts where account_code = 2700);

-- ---------------------------------------------------------------------------
-- 2. documents.category — new values for KYC / unit-holder documents
-- ---------------------------------------------------------------------------

-- None of documents' existing FK columns (property_id, tenant_id,
-- owner_id, partner_id) cleanly mean "Unit Holder" — reusing one of
-- them here would recreate the exact naming collision this feature
-- was designed to avoid, so it gets its own column.
alter table public.documents add column if not exists holder_profile_id uuid references public.profiles(id);
create index if not exists idx_documents_holder on public.documents(holder_profile_id);

alter table public.documents drop constraint if exists documents_category_check;

alter table public.documents add constraint documents_category_check
  check (category = ANY (ARRAY[
    'Lease'::text,
    'Commission Statement'::text,
    'Maintenance Invoice'::text,
    'Rent/Utility Invoice'::text,
    'Owner Statement'::text,
    'Inspection Report'::text,
    'Pictures'::text,
    'Bulletin'::text,
    'Professional Fees Invoice'::text,
    'Levy Statement'::text,
    'KYC ID Document'::text,
    'Proof of Address'::text,
    'Unit Purchase Agreement'::text,
    'Distribution Statement'::text,
    'Tax Certificate'::text
  ]));

-- documents already has RLS policies for admin/tenant/owner/partner from
-- earlier work (not in this repo — set up directly in Supabase). This adds
-- the Unit Holder's equivalent without touching those: a holder can see
-- and upload only their own holder_profile_id-tagged rows.
drop policy if exists "Holders can view their own documents" on public.documents;
create policy "Holders can view their own documents" on public.documents
  for select using (holder_profile_id = auth.uid());

drop policy if exists "Holders can upload their own KYC documents" on public.documents;
create policy "Holders can upload their own KYC documents" on public.documents
  for insert with check (
    holder_profile_id = auth.uid()
    and category in ('KYC ID Document', 'Proof of Address')
  );

-- ---------------------------------------------------------------------------
-- 3. Core tables
-- ---------------------------------------------------------------------------

create table if not exists public.unit_offerings (
  id uuid primary key default gen_random_uuid(),
  property_id bigint not null references public.properties(id),
  investor_entity_id uuid references public.investor_entities(id), -- the SPV entity for this property, if set up
  total_units integer not null check (total_units > 0),
  unit_price numeric(14,2) not null check (unit_price > 0),
  min_investment numeric(14,2),
  max_investment numeric(14,2),
  status text not null default 'draft' check (status in ('draft','open','closed','funded')),
  opened_at timestamptz,
  closed_at timestamptz,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_unit_offerings_property on public.unit_offerings(property_id);

-- Append-only, mirroring journal_entries: never edit units_held in place.
-- A correction/transfer inserts a new row and flips the old one to
-- 'superseded' — keeps an honest history instead of silently rewriting it.
create table if not exists public.unit_holdings (
  id uuid primary key default gen_random_uuid(),
  offering_id uuid not null references public.unit_offerings(id),
  holder_profile_id uuid not null references public.profiles(id),
  units_held integer not null check (units_held > 0),
  purchase_amount numeric(14,2) not null check (purchase_amount >= 0),
  purchase_date date not null,
  status text not null default 'active' check (status in ('active','superseded','redeemed')),
  posted_journal_id uuid,
  posting_error text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_unit_holdings_offering on public.unit_holdings(offering_id);
create index if not exists idx_unit_holdings_holder on public.unit_holdings(holder_profile_id);

-- KYC/whitelist gate — a distinct population from tenants/owners/investor
-- entity reps, so this is its own table rather than overloading profiles.role.
create table if not exists public.unit_holder_kyc (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) unique,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.distribution_runs (
  id uuid primary key default gen_random_uuid(),
  offering_id uuid not null references public.unit_offerings(id),
  period_label text not null,
  gross_rental_income numeric(14,2) not null check (gross_rental_income >= 0),
  mortgage_service_deducted numeric(14,2) not null default 0 check (mortgage_service_deducted >= 0),
  management_fee_deducted numeric(14,2) not null default 0 check (management_fee_deducted >= 0),
  net_distributable numeric(14,2) not null,
  per_unit_amount numeric(14,4) not null,
  run_date date not null,
  posted_journal_id uuid,
  posting_error text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_distribution_runs_offering on public.distribution_runs(offering_id);

create table if not exists public.distribution_payouts (
  id uuid primary key default gen_random_uuid(),
  distribution_run_id uuid not null references public.distribution_runs(id),
  holder_profile_id uuid not null references public.profiles(id),
  units_held_snapshot integer not null,
  amount numeric(14,2) not null,
  status text not null default 'Pending' check (status in ('Pending','Paid')),
  paid_date date,
  payment_reference text,
  posted_journal_id uuid,
  posting_error text,
  created_at timestamptz not null default now()
);

create index if not exists idx_distribution_payouts_run on public.distribution_payouts(distribution_run_id);
create index if not exists idx_distribution_payouts_holder on public.distribution_payouts(holder_profile_id);

-- ---------------------------------------------------------------------------
-- 4. RLS — every table gets explicit policies from day one. (Two real bugs
-- this build already hit were a missing UPDATE policy and a missing check
-- constraint value — both silent-failure classes. Not repeating that here.)
-- ---------------------------------------------------------------------------

alter table public.unit_offerings enable row level security;
alter table public.unit_holdings enable row level security;
alter table public.unit_holder_kyc enable row level security;
alter table public.distribution_runs enable row level security;
alter table public.distribution_payouts enable row level security;

-- unit_offerings: admin full access; a holder can see an offering once they
-- hold (or have held) units in it.
create policy "Admins manage unit_offerings" on public.unit_offerings
  for all using (is_admin()) with check (is_admin());

create policy "Holders can view their offerings" on public.unit_offerings
  for select using (
    exists (
      select 1 from public.unit_holdings uh
      where uh.offering_id = unit_offerings.id
        and uh.holder_profile_id = auth.uid()
    )
  );

-- unit_holdings: admin full access; a holder can see only their own rows.
create policy "Admins manage unit_holdings" on public.unit_holdings
  for all using (is_admin()) with check (is_admin());

create policy "Holders can view their own holdings" on public.unit_holdings
  for select using (holder_profile_id = auth.uid());

-- unit_holder_kyc: admin full access (review queue); a holder can submit
-- and view their own KYC status, but cannot change its status themselves.
create policy "Admins manage unit_holder_kyc" on public.unit_holder_kyc
  for all using (is_admin()) with check (is_admin());

create policy "Holders can view their own KYC status" on public.unit_holder_kyc
  for select using (profile_id = auth.uid());

create policy "Holders can submit their own KYC" on public.unit_holder_kyc
  for insert with check (profile_id = auth.uid());

-- distribution_runs: admin full access; a holder can see runs for
-- offerings they hold (or held) units in.
create policy "Admins manage distribution_runs" on public.distribution_runs
  for all using (is_admin()) with check (is_admin());

create policy "Holders can view runs for their offerings" on public.distribution_runs
  for select using (
    exists (
      select 1 from public.unit_holdings uh
      where uh.offering_id = distribution_runs.offering_id
        and uh.holder_profile_id = auth.uid()
    )
  );

-- distribution_payouts: admin full access (including the UPDATE that
-- "Mark as Paid" needs — this is exactly the policy that was missing for
-- `payments` earlier in this build); a holder can see only their own payouts.
create policy "Admins manage distribution_payouts" on public.distribution_payouts
  for all using (is_admin()) with check (is_admin());

create policy "Holders can view their own payouts" on public.distribution_payouts
  for select using (holder_profile_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 5. Auto-posting triggers — same house style as tenant_invoices /
-- rental_invoices / payments: the write happens through a normal insert/
-- update from the app, a trigger posts the journal, soft-fails into
-- posting_error rather than blocking the write.
-- ---------------------------------------------------------------------------

-- 5a. Unit purchase: Dr Bank, Cr Unit Holder Capital.
create or replace function public.post_unit_purchase_journal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_property_id bigint;
  v_journal_id  uuid;
begin
  if new.status <> 'active' or coalesce(new.purchase_amount, 0) = 0 then
    return new;
  end if;

  select property_id into v_property_id from public.unit_offerings where id = new.offering_id;

  begin
    v_journal_id := public.create_journal_entry(
      new.purchase_date,
      format('Unit purchase — offering %s', new.offering_id),
      null,
      'Investment',
      'unit_holdings',
      new.id,
      jsonb_build_array(
        jsonb_build_object(
          'account_code', 1000, 'dr_cr', 'D', 'amount', new.purchase_amount,
          'property_id', v_property_id,
          'description', 'Unit purchase received', 'ref_code', 'UNITBUY'
        ),
        jsonb_build_object(
          'account_code', 3200, 'dr_cr', 'C', 'amount', new.purchase_amount,
          'property_id', v_property_id,
          'description', 'Unit Holder Capital contributed', 'ref_code', 'UNITBUY'
        )
      )
    );
    update public.unit_holdings set posted_journal_id = v_journal_id, posting_error = null where id = new.id;
  exception when others then
    update public.unit_holdings set posting_error = sqlerrm where id = new.id;
  end;

  return new;
end;
$$;

drop trigger if exists trg_post_unit_purchase_journal on public.unit_holdings;
create trigger trg_post_unit_purchase_journal
  after insert on public.unit_holdings
  for each row execute function public.post_unit_purchase_journal();

-- 5b. Distribution run declared: Dr Distributions Declared, Cr Distributions Payable.
create or replace function public.post_distribution_run_journal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_property_id bigint;
  v_journal_id  uuid;
begin
  if coalesce(new.net_distributable, 0) <= 0 then
    return new;
  end if;

  select property_id into v_property_id from public.unit_offerings where id = new.offering_id;

  begin
    v_journal_id := public.create_journal_entry(
      new.run_date,
      format('Distribution run — %s', new.period_label),
      null,
      'Distribution',
      'distribution_runs',
      new.id,
      jsonb_build_array(
        jsonb_build_object(
          'account_code', 3100, 'dr_cr', 'D', 'amount', new.net_distributable,
          'property_id', v_property_id,
          'description', format('Distribution declared — %s', new.period_label), 'ref_code', 'DIST'
        ),
        jsonb_build_object(
          'account_code', 2700, 'dr_cr', 'C', 'amount', new.net_distributable,
          'property_id', v_property_id,
          'description', format('Distribution payable — %s', new.period_label), 'ref_code', 'DIST'
        )
      )
    );
    update public.distribution_runs set posted_journal_id = v_journal_id, posting_error = null where id = new.id;
  exception when others then
    update public.distribution_runs set posting_error = sqlerrm where id = new.id;
  end;

  return new;
end;
$$;

drop trigger if exists trg_post_distribution_run_journal on public.distribution_runs;
create trigger trg_post_distribution_run_journal
  after insert on public.distribution_runs
  for each row execute function public.post_distribution_run_journal();

-- 5c. Payout marked Paid: Dr Distributions Payable, Cr Bank. Mirrors the
-- payments "Mark as Paid" trigger exactly — guards against re-firing on
-- an already-Paid row the same way.
create or replace function public.post_distribution_payout_journal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_property_id bigint;
  v_journal_id  uuid;
begin
  if TG_OP = 'UPDATE' and OLD.status = 'Paid' then
    return new;
  end if;
  if new.status <> 'Paid' then
    return new;
  end if;

  select p.property_id into v_property_id
  from public.distribution_runs dr
  join public.unit_offerings p on p.id = dr.offering_id
  where dr.id = new.distribution_run_id;

  begin
    v_journal_id := public.create_journal_entry(
      coalesce(new.paid_date, current_date),
      format('Distribution payout — %s', new.payment_reference),
      null,
      'Payout',
      'distribution_payouts',
      new.id,
      jsonb_build_array(
        jsonb_build_object(
          'account_code', 2700, 'dr_cr', 'D', 'amount', new.amount,
          'property_id', v_property_id,
          'description', 'Distribution paid out', 'ref_code', 'DISTPAY'
        ),
        jsonb_build_object(
          'account_code', 1000, 'dr_cr', 'C', 'amount', new.amount,
          'property_id', v_property_id,
          'description', 'Distribution paid out', 'ref_code', 'DISTPAY'
        )
      )
    );
    update public.distribution_payouts set posted_journal_id = v_journal_id, posting_error = null where id = new.id;
  exception when others then
    update public.distribution_payouts set posting_error = sqlerrm where id = new.id;
  end;

  return new;
end;
$$;

drop trigger if exists trg_post_distribution_payout_journal on public.distribution_payouts;
create trigger trg_post_distribution_payout_journal
  after insert or update on public.distribution_payouts
  for each row execute function public.post_distribution_payout_journal();

-- ---------------------------------------------------------------------------
-- 6. create_distribution_run() — the one privileged write path for
-- declaring a run. Snapshots active unit_holdings, computes the per-unit
-- amount, and fans out one distribution_payouts row per active holder in a
-- single transaction. Mirrors create_journal_entry() being the sole
-- posting path elsewhere — this is the sole "declare a distribution" path.
-- ---------------------------------------------------------------------------

create or replace function public.create_distribution_run(
  p_offering_id uuid,
  p_period_label text,
  p_gross_rental_income numeric,
  p_mortgage_service_deducted numeric,
  p_management_fee_deducted numeric,
  p_run_date date,
  p_created_by uuid default auth.uid()
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total_units      integer;
  v_net_distributable numeric(14,2);
  v_per_unit          numeric(14,4);
  v_run_id            uuid;
  v_holding           record;
begin
  select coalesce(sum(units_held), 0) into v_total_units
  from public.unit_holdings
  where offering_id = p_offering_id and status = 'active';

  if v_total_units = 0 then
    raise exception 'No active unit holdings for this offering — nothing to distribute.';
  end if;

  v_net_distributable := coalesce(p_gross_rental_income, 0) - coalesce(p_mortgage_service_deducted, 0) - coalesce(p_management_fee_deducted, 0);
  if v_net_distributable <= 0 then
    raise exception 'Net distributable amount must be greater than zero (gross % minus mortgage % minus fee %).',
      p_gross_rental_income, p_mortgage_service_deducted, p_management_fee_deducted;
  end if;

  v_per_unit := round(v_net_distributable / v_total_units, 4);

  insert into public.distribution_runs (
    offering_id, period_label, gross_rental_income, mortgage_service_deducted,
    management_fee_deducted, net_distributable, per_unit_amount, run_date, created_by
  ) values (
    p_offering_id, p_period_label, p_gross_rental_income, coalesce(p_mortgage_service_deducted, 0),
    coalesce(p_management_fee_deducted, 0), v_net_distributable, v_per_unit, p_run_date, p_created_by
  ) returning id into v_run_id;

  for v_holding in
    select holder_profile_id, units_held
    from public.unit_holdings
    where offering_id = p_offering_id and status = 'active'
  loop
    insert into public.distribution_payouts (
      distribution_run_id, holder_profile_id, units_held_snapshot, amount
    ) values (
      v_run_id, v_holding.holder_profile_id, v_holding.units_held,
      round(v_holding.units_held * v_per_unit, 2)
    );
  end loop;

  return v_run_id;
end;
$$;
