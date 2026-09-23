-- ============================================================================
-- ZANKA LEDGER MODULE — PHASE 1
-- 001_chart_of_accounts.sql
--
-- Creates the chart_of_accounts table and seeds it with Zanka's existing
-- 45-account chart, taken directly from "Zanka Financials 3.xlsx" ->
-- "Chart of Accounts" sheet. Codes and names are unchanged from that sheet
-- so historical transactions map onto this table without translation.
-- ============================================================================

create table if not exists public.chart_of_accounts (
  id              uuid primary key default gen_random_uuid(),
  account_code    integer not null unique,
  account_name    text not null,
  account_type    text not null check (account_type in ('Asset','Liability','Equity','Income','Expense')),
  account_subtype text,
  normal_balance  text not null check (normal_balance in ('D','C')),
  statement       text check (statement in ('BS','P&L')),
  notes           text,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now()
);

comment on table public.chart_of_accounts is
  'Zanka chart of accounts. Seeded from Zanka Financials 3.xlsx. Do not renumber existing codes — historical journals and reports reference them by account_code.';

insert into public.chart_of_accounts (account_code, account_name, account_type, account_subtype, normal_balance, statement, notes) values
  (1000, 'Bank', 'Asset', 'Current', 'D', 'BS', 'Main bank account'),
  (1100, 'Accounts Receivable', 'Asset', 'Current', 'D', 'BS', 'Rent/sales receivables'),
  (1150, 'Undeposited Funds', 'Asset', 'Current', 'D', 'BS', 'Payments confirmed by admin, not yet bank-reconciled'),
  (1200, 'Prepaid Expenses', 'Asset', 'Current', 'D', 'BS', null),
  (1300, 'Property Inventory (Flips)', 'Asset', 'Current', 'D', 'BS', 'Properties held for sale'),
  (1400, 'Work In Progress – Renovations', 'Asset', 'Current', 'D', 'BS', 'Flip renovations in progress'),
  (1500, 'Investment Property (Rentals)', 'Asset', 'Non-current', 'D', 'BS', 'Cost model: capitalised improvements added here'),
  (1550, 'Investment asset', 'Asset', 'Non-current', 'D', 'BS', 'Cost model: capitalised improvements added here'),
  (1600, 'Accumulated Depreciation – Investment Property', 'Asset', 'Non-current', 'C', 'BS', 'Contra asset'),
  (1700, 'Lease Acquisition Costs (Capitalised Commission)', 'Asset', 'Non-current', 'D', 'BS', 'Optional per policy'),
  (1800, 'Property Plant & Equipment', 'Asset', 'Non-current', 'D', 'BS', 'Optional per policy'),
  (2000, 'Accounts Payable', 'Liability', 'Current', 'C', 'BS', null),
  (2100, 'Tenant Deposits Held', 'Liability', 'Current', 'C', 'BS', 'Deposits received before/during lease'),
  (2200, 'Rent Received in Advance', 'Liability', 'Current', 'C', 'BS', 'If rent paid before period'),
  (2250, 'Deferred Rental Income', 'Liability', 'Current', 'C', 'BS', 'If rent paid before period'),
  (2300, 'Loans / Mortgages', 'Liability', 'Non-current', 'C', 'BS', null),
  (2400, 'Clearing / Settlement Account', 'Liability', 'Current', 'C', 'BS', 'Payment gateway clearing account'),
  (2500, 'Loan from owner', 'Liability', 'Current', 'C', 'BS', null),
  (3000, 'Owner Capital', 'Equity', 'Equity', 'C', 'BS', null),
  (3100, 'Retained Earnings', 'Equity', 'Equity', 'C', 'BS', null),
  (4000, 'Rental Income', 'Income', 'Rentals', 'C', 'P&L', null),
  (4100, 'Other Rental Income', 'Income', 'Rentals', 'C', 'P&L', 'Parking, utilities recoveries'),
  (4200, 'Property Sales – Flips', 'Income', 'Flips', 'C', 'P&L', 'Sale proceeds'),
  (5000, 'Cost of Sales – Flip Purchases', 'Expense', 'Flips (COGS)', 'D', 'P&L', 'Purchase price + transfer costs'),
  (5100, 'Cost of Sales – Flip Renovations', 'Expense', 'Flips (COGS)', 'D', 'P&L', 'Direct reno costs for flips'),
  (5200, 'Cost of Sales – Flip Holding Costs', 'Expense', 'Flips (COGS)', 'D', 'P&L', 'Rates, interest during flip'),
  (6000, 'Repairs & Maintenance (Expense)', 'Expense', 'Rentals', 'D', 'P&L', 'Non-capital repairs'),
  (6100, 'Rates & Taxes', 'Expense', 'Rentals', 'D', 'P&L', null),
  (6200, 'Insurance', 'Expense', 'Rentals', 'D', 'P&L', null),
  (6300, 'Utilities', 'Expense', 'Rentals', 'D', 'P&L', 'Landlord-paid utilities'),
  (6350, 'Utilities recoveries', 'Expense', 'Rentals', 'D', 'P&L', null),
  (6400, 'Property Management Fees', 'Expense', 'Rentals', 'D', 'P&L', null),
  (6500, 'Letting / Marketing Fees', 'Expense', 'Rentals', 'D', 'P&L', null),
  (6600, 'Agent Commission Expense', 'Expense', 'Rentals', 'D', 'P&L', 'Leasing commission'),
  (6700, 'Rental Expense', 'Expense', 'Rentals', 'D', 'P&L', null),
  (6800, 'Property Maintenance', 'Expense', 'Rentals', 'D', 'P&L', null),
  (7000, 'Salaries & Wages', 'Expense', 'Overheads', 'D', 'P&L', null),
  (7050, 'Drawings', 'Expense', 'Overheads', 'D', 'P&L', null),
  (7100, 'Office & Admin', 'Expense', 'Overheads', 'D', 'P&L', null),
  (7200, 'Professional Fees', 'Expense', 'Overheads', 'D', 'P&L', 'Legal, accounting'),
  (7300, 'Depreciation', 'Expense', 'Non-cash', 'D', 'P&L', null),
  (7400, 'Interest Expense', 'Expense', 'Finance', 'D', 'P&L', null),
  (7500, 'Bank Charges', 'Expense', 'Finance', 'D', 'P&L', null)
on conflict (account_code) do nothing;

-- Two accounts your spec calls for that aren't yet in the Excel chart of
-- accounts. Added as Phase 1 additions, not renumbers of anything existing.
insert into public.chart_of_accounts (account_code, account_name, account_type, account_subtype, normal_balance, statement, notes) values
  (2450, 'Payment Gateway Clearing / Merchant Receivable', 'Liability', 'Current', 'C', 'BS', 'Bridges successful platform payments and bank settlement (spec section 7). Separate from 2400 Clearing/Settlement so gateway and manual clearing don''t mix.'),
  (7550, 'Payment Processing Fees', 'Expense', 'Finance', 'D', 'P&L', 'Gateway fees on settlement (spec section 8)')
on conflict (account_code) do nothing;
