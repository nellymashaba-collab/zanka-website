-- ============================================================================
-- ZANKA LEDGER MODULE — PHASE 2
-- 020_levy_recharge.sql
--
-- Adds a dedicated levy/CSOS recharge component, kept deliberately separate
-- from rent/electricity/water/sewerage/other_charges (per your call — levy
-- costs aren't utility recoveries, they need their own line and their own
-- account). Used when publishing a Levy Statement with "Also invoice the
-- tenant for this levy amount" checked.
-- ============================================================================

alter table public.rental_invoices
  add column if not exists levy_csos numeric(14,2) not null default 0;

insert into public.chart_of_accounts (account_code, account_name, account_type, account_subtype, normal_balance, statement, notes)
select 6360, 'Levy Recoveries', 'Expense', 'Rentals', 'D', 'P&L', 'Added Phase 2 — levy/CSOS recharged to tenants, kept separate from Utilities recoveries (6350).'
where not exists (select 1 from public.chart_of_accounts where account_code = 6360);

create or replace function public.post_rental_invoice_journal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lines       jsonb := '[]'::jsonb;
  v_ar_total    numeric(14,2);
  v_rental_net  numeric(14,2);
  v_utilities   numeric(14,2);
  v_journal_id  uuid;
begin
  v_utilities  := coalesce(new.electricity, 0) + coalesce(new.water, 0) + coalesce(new.sewerage, 0) + coalesce(new.other_charges, 0);
  v_rental_net := coalesce(new.net_rental, 0) - coalesce(new.discount, 0);
  v_ar_total   := coalesce(new.net_rental, 0) + v_utilities + coalesce(new.levy_csos, 0) - coalesce(new.discount, 0) + coalesce(new.vat, 0);

  if v_ar_total is null or v_ar_total = 0 then
    return new;
  end if;

  v_lines := jsonb_build_array(jsonb_build_object(
    'account_code', 1100, 'dr_cr', 'D', 'amount', v_ar_total,
    'property_id', new.property_id, 'tenant_id', new.tenant_id,
    'description', 'Rent/Utility invoice', 'ref_code', 'INV'
  ));

  if v_rental_net > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_code', 4000, 'dr_cr', 'C', 'amount', v_rental_net,
      'property_id', new.property_id, 'tenant_id', new.tenant_id,
      'description', 'Rental income (net of discount)', 'ref_code', 'RENT'
    ));
  end if;

  if v_utilities > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_code', 6350, 'dr_cr', 'C', 'amount', v_utilities,
      'property_id', new.property_id, 'tenant_id', new.tenant_id,
      'description', 'Utilities recovered (electricity/water/sewerage/other)', 'ref_code', 'UTIL'
    ));
  end if;

  if coalesce(new.levy_csos, 0) > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_code', 6360, 'dr_cr', 'C', 'amount', new.levy_csos,
      'property_id', new.property_id, 'tenant_id', new.tenant_id,
      'description', 'Levy/CSOS recovered', 'ref_code', 'LEVY'
    ));
  end if;

  if coalesce(new.vat, 0) > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_code', 2600, 'dr_cr', 'C', 'amount', new.vat,
      'property_id', new.property_id, 'tenant_id', new.tenant_id,
      'description', 'VAT on invoice', 'ref_code', 'VAT'
    ));
  end if;

  begin
    v_journal_id := public.create_journal_entry(
      new.invoice_date,
      format('Rent/Utility invoice — property %s', new.property_id),
      null,
      'Invoice',
      'rental_invoices',
      null,
      v_lines
    );
    update public.rental_invoices set posted_journal_id = v_journal_id, posting_error = null where id = new.id;
  exception when others then
    update public.rental_invoices set posting_error = sqlerrm where id = new.id;
  end;

  return new;
end;
$$;
