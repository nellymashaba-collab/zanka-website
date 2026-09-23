-- ============================================================================
-- ZANKA LEDGER MODULE — PHASE 2
-- 011_tenant_invoice_posting.sql
--
-- Wires tenant_invoices into the general ledger. Every NEW invoice (from the
-- moment this trigger goes live, not retroactively — the 11 existing rows
-- predate this and are already covered by the Zanka Financials 3.xlsx
-- import from Phase 1) posts a balanced journal automatically:
--
--   Dr 1100 Accounts Receivable      total_due
--   Cr 4000 Rental Income            net_rental
--   Cr 6350 Utilities recoveries     electricity + water + sewerage + refuse
--   Cr 2100 Tenant Deposits Held     deposit
--
-- If total_due doesn't equal the sum of those components, create_journal_entry()
-- itself rejects the journal as unbalanced — that's a feature, not a bug: it
-- means the invoice's numbers don't add up and needs a human look, rather
-- than silently posting something wrong.
--
-- Posting failures do NOT block invoice creation. The invoice still saves;
-- the failure reason lands in posting_error for follow-up. An accounting
-- bug should never stop a tenant from receiving their invoice.
-- ============================================================================

alter table public.tenant_invoices
  add column if not exists posted_journal_id uuid references public.journal_entries(id),
  add column if not exists posting_error text;

create or replace function public.post_tenant_invoice_journal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lines      jsonb := '[]'::jsonb;
  v_utilities  numeric(14,2);
  v_journal_id uuid;
begin
  if new.total_due is null or new.total_due = 0 then
    return new;
  end if;

  v_lines := jsonb_build_array(
    jsonb_build_object(
      'account_code', 1100, 'dr_cr', 'D', 'amount', new.total_due,
      'property_id', new.property_id, 'tenant_id', new.tenant_id, 'lease_id', new.lease_id,
      'description', 'Tenant invoice ' || coalesce(new.invoice_number, new.id::text),
      'ref_code', 'INV'
    )
  );

  if coalesce(new.net_rental, 0) > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_code', 4000, 'dr_cr', 'C', 'amount', new.net_rental,
      'property_id', new.property_id, 'tenant_id', new.tenant_id, 'lease_id', new.lease_id,
      'description', 'Rental income', 'ref_code', 'RENT'
    ));
  end if;

  v_utilities := coalesce(new.electricity, 0) + coalesce(new.water, 0)
               + coalesce(new.sewerage, 0) + coalesce(new.refuse, 0);
  if v_utilities > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_code', 6350, 'dr_cr', 'C', 'amount', v_utilities,
      'property_id', new.property_id, 'tenant_id', new.tenant_id, 'lease_id', new.lease_id,
      'description', 'Utilities recovered (electricity/water/sewerage/refuse)', 'ref_code', 'UTIL'
    ));
  end if;

  if coalesce(new.deposit, 0) > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_code', 2100, 'dr_cr', 'C', 'amount', new.deposit,
      'property_id', new.property_id, 'tenant_id', new.tenant_id, 'lease_id', new.lease_id,
      'description', 'Tenant deposit held', 'ref_code', 'DEP'
    ));
  end if;

  begin
    v_journal_id := public.create_journal_entry(
      new.invoice_date,
      format('Tenant invoice %s', coalesce(new.invoice_number, new.id::text)),
      new.invoice_number,
      'Invoice',
      'tenant_invoices',
      new.id,
      v_lines,
      new.created_by
    );
    update public.tenant_invoices set posted_journal_id = v_journal_id, posting_error = null where id = new.id;
  exception when others then
    update public.tenant_invoices set posting_error = sqlerrm where id = new.id;
  end;

  return new;
end;
$$;

drop trigger if exists trg_post_tenant_invoice_journal on public.tenant_invoices;
create trigger trg_post_tenant_invoice_journal
  after insert on public.tenant_invoices
  for each row execute function public.post_tenant_invoice_journal();

comment on function public.post_tenant_invoice_journal is
  'Posts a journal for every new tenant_invoices row. Does not fire on UPDATE — correcting an already-posted invoice requires a manual reversal via reverse_journal_entry(), never editing the original journal.';
