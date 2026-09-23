-- ============================================================================
-- ZANKA LEDGER MODULE — PHASE 1
-- 003_general_ledger.sql
--
-- Double-entry general ledger core: journal_entries (the header / "Journal
-- ID" in your spreadsheet) and journal_lines (one row per Dr or Cr leg,
-- equivalent to your "Posting ID" rows in the Transactions sheet).
--
-- IMPORTANT: nothing in this module posts directly to these tables. Every
-- future invoice, payment, refund, etc. calls post_journal_entry() (see
-- 004_gl_functions.sql), which is the only path that can create a Posted
-- journal. This keeps the "payment channel must not directly manipulate
-- accounting balances" rule (spec section 1) enforceable at the DB level,
-- not just in application code.
-- ============================================================================

create table if not exists public.journal_entries (
  id                  uuid primary key default gen_random_uuid(),
  journal_number      text not null unique,  -- e.g. J-0001, matches your existing convention
  entry_date          date not null,
  period_id           uuid not null references public.accounting_periods(id),
  source_type         text not null default 'Manual'
                        check (source_type in ('Manual','Invoice','Payment','Refund','CreditNote','Reversal','Import')),
  source_table        text,       -- e.g. 'tenant_invoices', 'payments' — populated once those phases wire in
  source_id           uuid,       -- id of the row in source_table that caused this journal
  description         text,
  reference           text,       -- free-text reference (your "Ref Code" column, e.g. DEP, COM, ELE)
  status               text not null default 'Draft'
                        check (status in ('Draft','Posted','Reversed')),
  reverses_journal_id uuid references public.journal_entries(id),  -- set on the reversing entry
  reversed_by_journal_id uuid references public.journal_entries(id), -- set on the original, once reversed
  created_by          uuid references public.profiles(id),
  approved_by         uuid references public.profiles(id),
  posted_at           timestamptz,
  created_at          timestamptz not null default now()
);

comment on table public.journal_entries is
  'Journal header. Only status=Posted journals affect account balances (via journal_lines). Posted journals are never edited or deleted — use post a Reversal instead (spec section 36).';

create table if not exists public.journal_lines (
  id                uuid primary key default gen_random_uuid(),
  journal_entry_id  uuid not null references public.journal_entries(id) on delete cascade,
  line_number       integer not null,
  account_code      integer not null references public.chart_of_accounts(account_code),
  dr_cr             text not null check (dr_cr in ('D','C')),
  amount            numeric(14,2) not null check (amount >= 0),  -- >=0: some historical lines (e.g. "billed in arrears") were legitimately R0.00

  -- accounting dimensions — nullable because not every line is property/
  -- tenant/owner/lease specific (e.g. a corporate overhead expense), but
  -- populated wherever the spreadsheet populated Property/Tenant/Lease.
  property_id       bigint references public.properties(id),
  tenant_id         uuid references public.profiles(id),
  owner_id          uuid references public.profiles(id),
  partner_id        uuid references public.profiles(id),  -- agent / contractor / partner
  lease_id          bigint references public.leases(id),

  description       text,
  ref_code          text,
  tax_treatment     text,   -- e.g. 'Deductible', 'Ignore' — matches your Tax Treatment column
  tax_group         text,

  created_at        timestamptz not null default now(),

  unique (journal_entry_id, line_number)
);

comment on table public.journal_lines is
  'One row per debit or credit leg. Equivalent to a "Posting ID" row (e.g. J-0001-001) in the old Transactions sheet.';

create index if not exists idx_journal_lines_journal on public.journal_lines(journal_entry_id);
create index if not exists idx_journal_lines_account on public.journal_lines(account_code);
create index if not exists idx_journal_lines_property on public.journal_lines(property_id);
create index if not exists idx_journal_lines_tenant on public.journal_lines(tenant_id);
create index if not exists idx_journal_lines_owner on public.journal_lines(owner_id);
create index if not exists idx_journal_lines_lease on public.journal_lines(lease_id);
create index if not exists idx_journal_entries_date on public.journal_entries(entry_date);
create index if not exists idx_journal_entries_period on public.journal_entries(period_id);
create index if not exists idx_journal_entries_status on public.journal_entries(status);
create index if not exists idx_journal_entries_source on public.journal_entries(source_table, source_id);

-- ----------------------------------------------------------------------------
-- IMMUTABILITY GUARD
-- Once a journal_entry is Posted, its lines cannot be changed or deleted,
-- and the entry itself cannot be edited (only its status can move to
-- Reversed, which happens via post a new reversing journal, never by
-- mutating this one). This is the DB-level enforcement of spec section 36
-- ("Posted transactions must not be deleted. Use Reverse instead of Delete").
-- ----------------------------------------------------------------------------

create or replace function public.prevent_posted_journal_line_mutation()
returns trigger
language plpgsql
as $$
declare
  v_status text;
begin
  select status into v_status from public.journal_entries where id = coalesce(old.journal_entry_id, new.journal_entry_id);
  if v_status = 'Posted' then
    raise exception 'Cannot modify or delete lines on a Posted journal entry (%). Post a reversing journal instead.', coalesce(old.journal_entry_id, new.journal_entry_id);
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_prevent_posted_line_update on public.journal_lines;
create trigger trg_prevent_posted_line_update
  before update or delete on public.journal_lines
  for each row execute function public.prevent_posted_journal_line_mutation();

create or replace function public.prevent_posted_journal_entry_mutation()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'Posted' and new.status = 'Posted' then
    -- allow only reversed_by_journal_id to be set after the fact (when a later
    -- journal reverses this one); block every other field from changing.
    if new.journal_number is distinct from old.journal_number
       or new.entry_date is distinct from old.entry_date
       or new.period_id is distinct from old.period_id
       or new.description is distinct from old.description
       or new.reference is distinct from old.reference then
      raise exception 'Cannot modify a Posted journal entry (%). Post a reversing journal instead.', old.id;
    end if;
  elsif old.status = 'Posted' and new.status not in ('Posted','Reversed') then
    raise exception 'Cannot change a Posted journal entry to status %.', new.status;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prevent_posted_entry_update on public.journal_entries;
create trigger trg_prevent_posted_entry_update
  before update on public.journal_entries
  for each row execute function public.prevent_posted_journal_entry_mutation();

create or replace function public.prevent_posted_journal_entry_delete()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'Posted' then
    raise exception 'Cannot delete a Posted journal entry (%). Post a reversing journal instead.', old.id;
  end if;
  return old;
end;
$$;

drop trigger if exists trg_prevent_posted_entry_delete on public.journal_entries;
create trigger trg_prevent_posted_entry_delete
  before delete on public.journal_entries
  for each row execute function public.prevent_posted_journal_entry_delete();
