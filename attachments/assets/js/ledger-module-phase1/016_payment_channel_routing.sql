-- ============================================================================
-- ZANKA LEDGER MODULE — PHASE 2
-- 016_payment_channel_routing.sql
--
-- Revises 012's "everything debits Clearing" simplification now that manual
-- (EFT) payments actually need to land straight in Bank — money from an EFT
-- is already in your real account the moment it clears, there's no gateway
-- settlement delay for it. Only PayFast/portal payments hold in Clearing
-- until PayFast actually pays out.
--
--   Manual (EFT, via "Mark as Paid" button):  Dr 1000 Bank
--   Gateway (PayFast, once that's wired up):  Dr 2450 Payment Gateway Clearing
--
-- Nothing moves out of 2450 automatically — see 017_settle_gateway_clearing.sql
-- for the manual "money actually landed, clear it to Bank" step.
-- ============================================================================

alter table public.payments
  add column if not exists payment_method text check (payment_method in ('Manual','Gateway'));

comment on column public.payments.payment_method is
  'Manual = EFT/bank transfer, confirmed by staff (debits Bank directly). Gateway = PayFast or similar (debits Payment Gateway Clearing until settled). Defaults to Manual since no gateway webhook exists yet.';

create or replace function public.post_payment_journal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_journal_id    uuid;
  v_property_id   bigint;
  v_lease_id      bigint;
  v_reference     text;
  v_debit_account integer;
begin
  if new.status <> 'Paid' then
    return new;
  end if;

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

  -- Manual (EFT) lands straight in Bank. Gateway (PayFast, once that
  -- webhook exists) holds in Clearing until it's actually paid out.
  v_debit_account := case
    when coalesce(new.payment_method, 'Manual') = 'Gateway' then 2450
    else 1000
  end;

  begin
    v_journal_id := public.create_journal_entry(
      coalesce(new.paid_date, current_date),
      format('Payment received (%s)', v_reference),
      v_reference,
      'Payment',
      'payments',
      null,
      jsonb_build_array(
        jsonb_build_object(
          'account_code', v_debit_account, 'dr_cr', 'D', 'amount', new.amount,
          'tenant_id', new.tenant_id, 'property_id', v_property_id, 'lease_id', v_lease_id,
          'description', case when v_debit_account = 2450 then 'Payment received via gateway (pending settlement)' else 'Payment received via EFT' end,
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
