-- ============================================================================
-- ZANKA LEDGER MODULE — PHASE 1
-- 009_import_legacy_transactions.sql
--
-- Walks stg_legacy_transactions journal by journal, builds the jsonb line
-- array, and posts each through create_journal_entry() — the same function
-- every future invoice/payment will use. This is intentional: importing
-- history through the real posting path proves the engine handles your
-- actual data, not synthetic test data.
--
-- Run 007 and 008 first. Safe to re-run: already-imported rows are skipped.
-- ============================================================================

create or replace function public.import_staged_legacy_transactions()
returns table(journal_number text, journal_id uuid, status text)
language plpgsql
as $$
declare
  v_journal_number text;
  v_lines jsonb;
  v_entry_date date;
  v_new_id uuid;
  v_prop_map jsonb;
  v_tenant_map jsonb;
  v_lease_map jsonb;
begin
  -- pull confirmed reference mappings once
  select jsonb_object_agg(legacy_code, resolved_id) into v_prop_map
    from public.stg_legacy_ref_map where entity_type = 'property' and confirmed and resolved_id is not null;
  select jsonb_object_agg(legacy_code, resolved_id) into v_tenant_map
    from public.stg_legacy_ref_map where entity_type = 'tenant' and confirmed and resolved_id is not null;
  select jsonb_object_agg(legacy_code, resolved_id) into v_lease_map
    from public.stg_legacy_ref_map where entity_type = 'lease' and confirmed and resolved_id is not null;

  for v_journal_number, v_entry_date in
    select t.journal_number, min(t.entry_date)
    from public.stg_legacy_transactions t
    where not t.imported
    group by t.journal_number
    order by t.journal_number
  loop
    select jsonb_agg(jsonb_build_object(
      'account_code', t.account_code,
      'dr_cr', t.dr_cr,
      'amount', t.amount,
      'property_id', v_prop_map ->> t.property_code,
      'tenant_id', v_tenant_map ->> t.tenant_code,
      'lease_id', v_lease_map ->> t.lease_code,
      'description', t.description,
      'ref_code', t.ref_code,
      'tax_treatment', t.tax_treatment,
      'tax_group', t.tax_group
    ) order by t.row_seq)
    into v_lines
    from public.stg_legacy_transactions t
    where t.journal_number = v_journal_number and not t.imported;

    begin
      v_new_id := public.create_journal_entry(
        v_entry_date,
        format('Imported from Zanka Financials 3.xlsx (%s)', v_journal_number),
        v_journal_number,
        'Import',
        'stg_legacy_transactions',
        null,
        v_lines
      );

      update public.stg_legacy_transactions t
        set imported = true
        where t.journal_number = v_journal_number;

      journal_number := v_journal_number;
      journal_id := v_new_id;
      status := 'imported';
      return next;

    exception when others then
      journal_number := v_journal_number;
      journal_id := null;
      status := 'FAILED: ' || sqlerrm;
      return next;
    end;
  end loop;
end;
$$;

comment on function public.import_staged_legacy_transactions is
  'One-time migration helper. Call with: select * from public.import_staged_legacy_transactions(); Review the status column — anything not "imported" needs attention before you trust the ledger totals.';

-- To run:
--   select * from public.import_staged_legacy_transactions();
--
-- To verify afterwards:
--   select * from public.v_trial_balance_check;   -- is_balanced must be true
--   select * from public.v_trial_balance order by account_code;
