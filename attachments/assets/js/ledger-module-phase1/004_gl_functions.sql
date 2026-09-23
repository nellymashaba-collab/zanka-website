-- ============================================================================
-- ZANKA LEDGER MODULE — PHASE 1
-- 004_gl_functions.sql
--
-- The only supported way to create a Posted journal entry. Application code
-- (invoice posting, payment recording, refunds, etc. in later phases) must
-- call create_journal_entry() — never insert directly into journal_entries /
-- journal_lines with status='Posted'. SECURITY DEFINER + explicit grants
-- (see 005_rls_policies.sql) mean this is also the enforcement point for
-- "no direct client-side journal posting" (spec section 51).
-- ============================================================================

-- create_journal_entry: takes a journal header plus a JSON array of lines,
-- validates everything, and posts atomically. Returns the new journal_entries.id.
--
-- p_lines shape (jsonb array), one object per line:
--   {
--     "account_code": 1150, "dr_cr": "D", "amount": 9000,
--     "property_id": 1, "tenant_id": "...", "owner_id": null,
--     "partner_id": null, "lease_id": 1,
--     "description": "...", "ref_code": "DEP",
--     "tax_treatment": "Ignore", "tax_group": "Other"
--   }
create or replace function public.create_journal_entry(
  p_entry_date    date,
  p_description   text,
  p_reference     text,
  p_source_type   text,
  p_source_table  text,
  p_source_id     uuid,
  p_lines         jsonb,
  p_created_by    uuid default auth.uid()
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_journal_id     uuid;
  v_journal_number text;
  v_period_id      uuid;
  v_line           jsonb;
  v_line_no        integer := 0;
  v_total_dr       numeric(14,2) := 0;
  v_total_cr       numeric(14,2) := 0;
  v_next_seq       integer;
begin
  if p_lines is null or jsonb_array_length(p_lines) < 2 then
    raise exception 'A journal entry needs at least two lines (one Dr, one Cr).';
  end if;

  v_period_id := public.find_period_for_date(p_entry_date);
  if v_period_id is null then
    raise exception 'No open accounting period covers date %. Create/open the relevant period first.', p_entry_date;
  end if;

  if (select status from public.accounting_periods where id = v_period_id) <> 'Open' then
    raise exception 'Accounting period covering % is not Open. Corrections to closed periods require a reversal in an open period.', p_entry_date;
  end if;

  -- pre-validate balance before touching any tables
  select
    coalesce(sum((l->>'amount')::numeric) filter (where l->>'dr_cr' = 'D'), 0),
    coalesce(sum((l->>'amount')::numeric) filter (where l->>'dr_cr' = 'C'), 0)
  into v_total_dr, v_total_cr
  from jsonb_array_elements(p_lines) as l;

  if round(v_total_dr, 2) <> round(v_total_cr, 2) then
    raise exception 'Journal does not balance: total debits % <> total credits %.', v_total_dr, v_total_cr;
  end if;

  if v_total_dr = 0 then
    raise exception 'Journal has zero value.';
  end if;

  -- allocate the next journal number (J-0001, J-0002, ...)
  select coalesce(max(substring(journal_number from 3)::integer), 0) + 1
  into v_next_seq
  from public.journal_entries
  where journal_number ~ '^J-[0-9]+$';

  v_journal_number := 'J-' || lpad(v_next_seq::text, 4, '0');

  insert into public.journal_entries (
    journal_number, entry_date, period_id, source_type, source_table, source_id,
    description, reference, status, created_by, posted_at
  ) values (
    v_journal_number, p_entry_date, v_period_id, p_source_type, p_source_table, p_source_id,
    p_description, p_reference, 'Posted', p_created_by, now()
  )
  returning id into v_journal_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_line_no := v_line_no + 1;

    if not exists (select 1 from public.chart_of_accounts where account_code = (v_line->>'account_code')::integer) then
      raise exception 'Unknown account_code % on line %.', v_line->>'account_code', v_line_no;
    end if;

    insert into public.journal_lines (
      journal_entry_id, line_number, account_code, dr_cr, amount,
      property_id, tenant_id, owner_id, partner_id, lease_id,
      description, ref_code, tax_treatment, tax_group
    ) values (
      v_journal_id, v_line_no,
      (v_line->>'account_code')::integer,
      v_line->>'dr_cr',
      (v_line->>'amount')::numeric,
      nullif(v_line->>'property_id','')::bigint,
      nullif(v_line->>'tenant_id','')::uuid,
      nullif(v_line->>'owner_id','')::uuid,
      nullif(v_line->>'partner_id','')::uuid,
      nullif(v_line->>'lease_id','')::bigint,
      v_line->>'description',
      v_line->>'ref_code',
      v_line->>'tax_treatment',
      v_line->>'tax_group'
    );
  end loop;

  return v_journal_id;
end;
$$;

comment on function public.create_journal_entry is
  'The single entry point for posting a balanced journal. Rejects unbalanced journals, journals into closed periods, and unknown accounts. Used by every payment channel per spec section 1 — no channel writes to journal_entries/journal_lines directly.';

-- reverse_journal_entry: posts a new journal that exactly mirrors an existing
-- Posted journal with Dr/Cr flipped, and links the two together. This is the
-- ONLY way to undo a posted journal (spec section 36 — never delete).
create or replace function public.reverse_journal_entry(
  p_journal_id  uuid,
  p_reason      text,
  p_entry_date  date default current_date,
  p_created_by  uuid default auth.uid()
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_original record;
  v_lines    jsonb;
  v_new_id   uuid;
begin
  select * into v_original from public.journal_entries where id = p_journal_id;

  if v_original is null then
    raise exception 'Journal % not found.', p_journal_id;
  end if;
  if v_original.status <> 'Posted' then
    raise exception 'Only Posted journals can be reversed (journal % is %).', p_journal_id, v_original.status;
  end if;
  if exists (select 1 from public.journal_entries where reverses_journal_id = p_journal_id) then
    raise exception 'Journal % has already been reversed.', p_journal_id;
  end if;

  select jsonb_agg(jsonb_build_object(
    'account_code', account_code,
    'dr_cr', case dr_cr when 'D' then 'C' else 'D' end,
    'amount', amount,
    'property_id', property_id,
    'tenant_id', tenant_id,
    'owner_id', owner_id,
    'partner_id', partner_id,
    'lease_id', lease_id,
    'description', description,
    'ref_code', ref_code,
    'tax_treatment', tax_treatment,
    'tax_group', tax_group
  ) order by line_number)
  into v_lines
  from public.journal_lines
  where journal_entry_id = p_journal_id;

  v_new_id := public.create_journal_entry(
    p_entry_date,
    format('Reversal of %s: %s', v_original.journal_number, coalesce(p_reason, v_original.description)),
    v_original.reference,
    'Reversal',
    v_original.source_table,
    v_original.source_id,
    v_lines,
    p_created_by
  );

  update public.journal_entries set reverses_journal_id = v_new_id where id = p_journal_id;
  update public.journal_entries set status = 'Reversed', reversed_by_journal_id = v_new_id where id = p_journal_id;

  return v_new_id;
end;
$$;

comment on function public.reverse_journal_entry is
  'Reverses a Posted journal by posting a new mirrored journal, never by editing/deleting the original. Original moves to status=Reversed and is linked both ways.';
