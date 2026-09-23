-- ============================================================================
-- ZANKA LEDGER MODULE — PHASE 2
-- 017_settle_gateway_clearing.sql
--
-- Nothing moves out of 2450 Payment Gateway Clearing automatically — that's
-- intentional. It only moves when you can point at an actual payout that
-- landed in your real bank account (from your PayFast merchant statement).
-- Call this once you see that payout:
--
--   select settle_gateway_clearing('2026-08-16', 5000.00, 150.00, 'PayFast batch #123');
--
-- Posts:
--   Dr 1000 Bank                        gross - fee  (what actually landed)
--   Dr 7550 Payment Processing Fees     fee          (PayFast's cut)
--   Cr 2450 Payment Gateway Clearing    gross         (clears the receivable)
--
-- p_fee_amount can be 0 if you're recording it separately or PayFast took
-- no fee on this batch.
-- ============================================================================

create or replace function public.settle_gateway_clearing(
  p_settlement_date date,
  p_gross_amount    numeric,
  p_fee_amount      numeric default 0,
  p_reference       text default null,
  p_created_by      uuid default auth.uid()
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_net numeric(14,2);
  v_lines jsonb;
begin
  if p_gross_amount is null or p_gross_amount <= 0 then
    raise exception 'Gross settlement amount must be positive.';
  end if;

  v_net := p_gross_amount - coalesce(p_fee_amount, 0);
  if v_net <= 0 then
    raise exception 'Net amount (gross minus fee) must be positive — check the fee isn''t larger than the gross amount.';
  end if;

  v_lines := jsonb_build_array(
    jsonb_build_object('account_code', 1000, 'dr_cr', 'D', 'amount', v_net,
      'description', 'Gateway payout received', 'ref_code', 'SETTLE')
  );

  if coalesce(p_fee_amount, 0) > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_code', 7550, 'dr_cr', 'D', 'amount', p_fee_amount,
      'description', 'Payment gateway processing fee', 'ref_code', 'FEE'
    ));
  end if;

  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'account_code', 2450, 'dr_cr', 'C', 'amount', p_gross_amount,
    'description', 'Cleared from merchant receivable', 'ref_code', 'SETTLE'
  ));

  return public.create_journal_entry(
    p_settlement_date,
    format('Gateway settlement: R%s cleared to bank (fee R%s)', p_gross_amount, coalesce(p_fee_amount, 0)),
    p_reference,
    'Manual',
    'gateway_settlement',
    null,
    v_lines,
    p_created_by
  );
end;
$$;

comment on function public.settle_gateway_clearing is
  'Manual step: call once a PayFast payout actually lands in the bank account, moving that amount from 2450 Clearing to 1000 Bank and expensing the fee. Never fires automatically.';

grant execute on function public.settle_gateway_clearing(date, numeric, numeric, text, uuid) to authenticated;
