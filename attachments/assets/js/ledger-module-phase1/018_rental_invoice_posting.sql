-- ============================================================================
-- ZANKA LEDGER MODULE — PHASE 2
-- 018_rental_invoice_posting.sql
--
-- Wires the "Rent/Utility Invoice" direct-upload flow (non-10%-package
-- properties) into the ledger — this was the gap flagged after testing:
-- rental_invoices never touched the ledger, only the payments side did.
--
-- discount/vat already exist on `documents` (saved by the upload form) but
-- not on `rental_invoices` itself, and the trigger needs them at INSERT
-- time on rental_invoices — before the documents row even exists in that
-- same form submission. So they're added here too, source of truth for
-- ledger purposes.
--
--   Dr 1100 Accounts Receivable   net_rental + utilities - discount + vat
--   Cr 4000 Rental Income         net_rental - discount
--   Cr 6350 Utilities recoveries  electricity + water + sewerage + other_charges
--   Cr 2600 VAT Payable           vat   (new account — nothing existing charges VAT yet)
-- ============================================================================

alter table public.rental_invoices
  add column if not exists tenant_id         uuid references public.profiles(id),
  add column if not exists discount          numeric(14,2) not null default 0,
  add column if not exists vat               numeric(14,2) not null default 0,
  add column if not exists posted_journal_id uuid references public.journal_entries(id),
  add column if not exists posting_error     text;

alter table public.payments
  add column if not exists rental_invoice_id bigint references public.rental_invoices(id);

insert into public.chart_of_accounts (account_code, account_name, account_type, account_subtype, normal_balance, statement, notes)
select 2600, 'VAT Payable (Output VAT)', 'Liability', 'Current', 'C', 'BS', 'Added Phase 2 — not in the original spreadsheet chart, needed for the Rent/Utility Invoice VAT field.'
where not exists (select 1 from public.chart_of_accounts where account_code = 2600);

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
  v_ar_total   := coalesce(new.net_rental, 0) + v_utilities - coalesce(new.discount, 0) + coalesce(new.vat, 0);

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

drop trigger if exists trg_post_rental_invoice_journal on public.rental_invoices;
create trigger trg_post_rental_invoice_journal
  after insert on public.rental_invoices
  for each row execute function public.post_rental_invoice_journal();

comment on function public.post_rental_invoice_journal is
  'Posts a journal for every new rental_invoices row (the direct-upload Rent/Utility Invoice flow). Mirrors post_tenant_invoice_journal but for non-10%-package properties. Discount reduces Rental Income directly; VAT posts to 2600 VAT Payable.';
