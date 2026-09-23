-- ============================================================================
-- ZANKA LEDGER MODULE — PHASE 2
-- 012_payment_posting.sql
--
-- Wires payments into the general ledger. A payments row only exists once
-- money has actually landed (confirmed), so the moment status becomes
-- 'Paid' — on insert or on update — it posts:
--
--   Dr 2450 Payment Gateway Clearing   amount
--   Cr 1100 Accounts Receivable        amount
--
-- Every channel (PayFast gateway or manual/EFT capture) lands in Clearing
-- for now — Phase 3 (bank/gateway reconciliation) is what moves it from
-- Clearing to the real Bank account once it actually settles.
--
-- If tenant_invoice_id is set, the invoice's property_id/lease_id are
-- pulled across so the line carries the same reporting tags. If it's null
-- (an unlinked/advance payment — this happens today, 1 of 12 existing rows),
-- the line still posts against the tenant's AR, just without a property tag.
--
-- Posting failures do NOT block the payment from saving, same reasoning as
-- tenant invoice posting (011).
-- ============================================================================

alter table public.payments
  add column if not exists posted_journal_id uuid references public.journal_entries(id),
  add column if not exists posting_error text;

create or replace function public.post_payment_journal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_journal_id  uuid;
  v_property_id bigint;
  v_lease_id    bigint;
  v_reference   text;
begin
  if new.status <> 'Paid' then
    return new;
  end if;

  -- already posted on a prior update — don't double-post
  if TG_OP = 'UPDATE' and OLD.status = 'Paid' then
    return new;
  end if;

  if new.amount is null or new.amount = 0 then
    return new;
  end if;

  if new.tenant_invoice_id is not null then
    select property_id, lease_id into v_property_id, v_lease_id
    from public.tenant_invoices where id = new.tenant_invoice_id;
  end if;

  v_reference := coalesce(new.gateway_reference, 'PAY-' || new.id::text);

  begin
    v_journal_id := public.create_journal_entry(
      coalesce(new.paid_date, current_date),
      format('Payment received (%s)', v_reference),
      v_reference,
      'Payment',
      'payments',
      null,  -- payments.id is bigint, create_journal_entry's source_id is uuid; reference carries the link instead
      jsonb_build_array(
        jsonb_build_object(
          'account_code', 2450, 'dr_cr', 'D', 'amount', new.amount,
          'tenant_id', new.tenant_id, 'property_id', v_property_id, 'lease_id', v_lease_id,
          'description', 'Payment received via ' || case when new.gateway_reference is not null then 'gateway' else 'manual capture' end,
          'ref_code', 'PMT'
        ),
        jsonb_build_object(
          'account_code', 1100, 'dr_cr', 'C', 'amount', new.amount,
          'tenant_id', new.tenant_id, 'property_id', v_property_id, 'lease_id', v_lease_id,
          'description', 'Applied to tenant account', 'ref_code', 'PMT'
        )
      )
    );
    update public.payments set posted_journal_id = v_journal_id, posting_error = null where id = new.id;
  exception when others then
    update public.payments set posting_error = sqlerrm where id = new.id;
  end;

  return new;
end;
$$;

drop trigger if exists trg_post_payment_journal on public.payments;
create trigger trg_post_payment_journal
  after insert or update on public.payments
  for each row execute function public.post_payment_journal();

comment on function public.post_payment_journal is
  'Posts a journal the moment a payment becomes Paid (insert or update). Skips if already Paid on the prior row version, so updates to other columns never double-post.';
