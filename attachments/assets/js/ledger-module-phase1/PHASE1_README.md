# Zanka Ledger Module — Phase 1

Phase 1 of your 55-section spec: **chart of accounts + double-entry general ledger core.** Everything else (invoicing, payment channels, gateway clearing, reconciliation, sub-ledgers, dashboards) depends on this being right, so nothing else was built yet.

## What's in this phase

| File | What it does |
|---|---|
| `001_chart_of_accounts.sql` | Creates `chart_of_accounts`, seeded with your real 45 accounts from *Zanka Financials 3.xlsx*, plus 2 new accounts your spec needs that weren't in the sheet yet (Payment Gateway Clearing, Payment Processing Fees). |
| `002_accounting_periods.sql` | Creates `accounting_periods`, seeded Oct 2025–Jun 2026 as monthly periods, all Open. |
| `003_general_ledger.sql` | Creates `journal_entries` (header) and `journal_lines` (Dr/Cr legs), with triggers that make Posted journals immutable — no edits, no deletes, only reversals. |
| `004_gl_functions.sql` | `create_journal_entry()` — the only way to post a journal. Rejects unbalanced journals, journals into closed periods, and unknown accounts. `reverse_journal_entry()` — the only way to undo one. |
| `005_rls_policies.sql` | Row-level security. **Flagged assumption inside**: I don't know your real `profiles` role column, so this assumes `profiles.role`. Confirm before running. |
| `006_reporting_views.sql` | Trial balance + account balance views, computed live from Posted journals only. |
| `007_staging_legacy_transactions.sql` | All 359 historical posting lines from the spreadsheet, staged. 4 journal pairs merged into one journal each (see below) so every journal balances. |
| `008_resolve_legacy_references.sql` | Maps your spreadsheet's P-001/T-001/L-001 codes to real database IDs, using your confirmed column names. |
| `009_import_legacy_transactions.sql` | Replays the staged history through `create_journal_entry()` for real, proving the engine handles your actual data. |

## A data issue I found — now resolved

Before staging anything, I balance-checked all 49 of your existing journals. 45 balanced perfectly; 4 pairs didn't individually, but you confirmed each pair is one transaction whose two legs were recorded under separate journal numbers (J-0008/J-0009, J-0028/J-0029, J-0040/J-0043, J-0041/J-0042). `007_staging_legacy_transactions.sql` now merges each pair into a single journal number. All 45 resulting journals (359 posting lines total) balance exactly.

## Before you run any of this

1. Schema assumptions confirmed: `profiles.role`, `properties.address`, `profiles.full_name` all exist as named. `008_resolve_legacy_references.sql` now runs its UPDATE statements for real (previously commented out).
2. **Run this in a Supabase branch/staging environment first**, not directly on production. None of this has been executed against a real Postgres instance (I don't have a database connection in this session) — only checked for balanced parentheses and manually reviewed line by line.
3. In `008`, after the UPDATEs run, review the printed `stg_legacy_ref_map` table before trusting it — if `P-001`/`P-002`/`T-001`/`T-002`/`L-001`/`L-002` don't all show a `resolved_id`, those specific lines will still import (amounts post correctly regardless), just without a property/tenant/lease tag until you fix the match manually.

## Suggested run order

```
001 → 002 → 003 → 004 → 005 → 006
```
Test here: post a manual journal via `select create_journal_entry(...)`, then check `select * from v_trial_balance_check;` returns `is_balanced = true`. Try to post an unbalanced journal and confirm it's rejected. Try to edit a Posted journal_line and confirm it's rejected.

Then, once the two confirmations above are done:
```
007 → 008 (fill in real IDs, set confirmed = true) → 009
```
Run `select * from import_staged_legacy_transactions();`, check every row says `imported`, then `select * from v_trial_balance_check;` again.

## Status: verified ✅

All 359 historical posting lines imported successfully across 45 journals. `010_verify_import.sql` passes in full, including CHECK 4 (all 42 accounts match the spreadsheet's own Trial Balance sheet to the cent).

Two bugs surfaced during the real import run and were fixed:
1. `009_import_legacy_transactions.sql` had an unqualified `journal_number` reference in the post-insert UPDATE, ambiguous against the function's own `returns table(journal_number ...)` output column. This caused every journal to insert successfully via `create_journal_entry()` and then get silently rolled back by the exception handler on the next line. Fixed by qualifying it (`t.journal_number`).
2. `journal_lines.amount` had a `> 0` check constraint. Two historical journals (J-0040, J-0046) contain genuine R0.00 lines ("billed in arrears" placeholders). Per your call, the constraint was relaxed to `>= 0` rather than dropping those rows.

Both fixes are reflected in `003_general_ledger.sql` and `009_import_legacy_transactions.sql` in this folder.

## Phase 2: invoice + payment posting ✅

Found your existing schema first (`tenant_invoices`, `payments`, `rental_invoices`, `partner_invoices`, `contractor_invoices`, plus the `generate_tenant_invoice_number` trigger) rather than building new tables. Only `tenant_invoices` and `payments` are wired to the ledger — those are the two with real financial lifecycle.

| File | What it does |
|---|---|
| `011_tenant_invoice_posting.sql` | Adds `posted_journal_id`/`posting_error` to `tenant_invoices`. Trigger posts a journal on every new invoice: Dr 1100 AR, Cr 4000 Rental Income, Cr 6350 Utilities recoveries (electricity+water+sewerage+refuse), Cr 2100 Tenant Deposits Held. |
| `012_payment_posting.sql` | Adds the same two columns to `payments`. Trigger posts Dr 2450 Payment Gateway Clearing / Cr 1100 AR the moment a payment's status becomes `Paid`. |
| `013_extend_accounting_periods.sql` | Extends periods through Dec 2027 — Phase 1 only seeded to Jun 2026, so this must run before 011/012 go live or every new invoice will fail to post. |

**Decisions confirmed with you:**
- The 11 existing `tenant_invoices` / 12 existing `payments` rows are not backfilled — they predate this system and are already counted in the Zanka Financials 3.xlsx import (Phase 1). Only new rows post from here on.
- `refuse` charges post to 6350 Utilities recoveries, same treatment as electricity/water/sewerage.
- All payments debit 2450 Payment Gateway Clearing regardless of channel; sorting Clearing → actual Bank is Phase 3's job (reconciliation).
- `rental_invoices` is an owner-side property charge record, separate from tenant billing — not wired into the ledger in this phase.

**Design notes:**
- Posting failures never block the invoice/payment from saving — the row saves either way, the failure lands in `posting_error`. An accounting bug should never stop a tenant from getting their invoice or a payment from recording.
- If `total_due` doesn't equal the sum of its components, `create_journal_entry()` rejects the journal as unbalanced (caught, logged to `posting_error`) rather than silently posting something wrong.
- Editing an already-posted invoice does NOT re-post or adjust the journal — corrections need a manual reversal via `reverse_journal_entry()`, consistent with "never edit a Posted journal."
- A payment whose posting failed doesn't auto-retry on a later update while status stays `Paid` — check `posting_error is not null` periodically and remediate manually for now.

## Phase 2 add-ons: EFT payment button + Excel export ✅

| File | What it does |
|---|---|
| `014_period_trial_balance_rpc.sql` | `get_period_trial_balance(period_id)` — per-account Dr/Cr totals for ONE period only (unlike `v_trial_balance`, which is lifetime-to-date). Powers the Excel export. |

App changes (in `attachments/`, not this folder):
- **`admin-dashboard.html` / `assets/js/admin-dashboard.js` — Payments table**: added a Tenant column and a "Mark as Paid (EFT)" button on any Pending row. Clicking it prompts for an optional EFT reference, updates `payments.status = 'Paid'`, and the Phase 2 trigger (012) posts the journal automatically — no separate action needed.
- **New "Reports" section**: a period dropdown (from `accounting_periods`) and an Export to Excel button. Produces a 2-sheet `.xlsx` — Trial Balance (that period only) and Journal Detail (every posted line) — built client-side via SheetJS, downloaded directly in the browser.

**Known gap to close before wider rollout**: `get_period_trial_balance`, like `create_journal_entry`/`reverse_journal_entry` in Phase 1, is granted to any authenticated user with no internal role check — it's only exposed in the admin dashboard today, but a tenant or owner account could technically call it directly and see aggregate ledger balances. Worth adding a role check inside these functions once the admin-only surface area is confirmed final.

## Phase 2 fix: missing UPDATE policy on `payments` ✅

| File | What it does |
|---|---|
| `015_payments_update_policy.sql` | Adds an admin UPDATE policy to `payments`. It had SELECT and INSERT policies but no UPDATE policy at all — a pre-existing gap, not something the ledger module introduced. |

**What happened**: the "Mark as Paid (EFT)" button appeared to work — Chrome's Network tab showed `204` — but the row never actually changed and the journal never posted. RLS was silently blocking the UPDATE (0 rows matched), and PostgREST returns 204 by default even when nothing was written, since supabase-js doesn't request `return=representation`. A direct SQL update (which bypasses RLS, running as the database owner) worked immediately, which is what exposed the gap. Confirmed fixed: `payments.id = 47` now shows `status = 'Paid'` with a real `posted_journal_id`.

**Lesson for later phases**: any new UPDATE path through the app (not just SELECT/INSERT) needs its own RLS policy — it won't error, it'll just silently do nothing, which is much harder to notice.

## Phase 2 refinement: Manual vs Gateway payment routing ✅

| File | What it does |
|---|---|
| `016_payment_channel_routing.sql` | Adds `payment_method` ('Manual'/'Gateway') to `payments`. Manual (EFT, via the button) now debits 1000 Bank directly. Gateway (PayFast, once that webhook is built) debits 2450 Payment Gateway Clearing instead. Supersedes 012's "everything to Clearing" simplification. |
| `017_settle_gateway_clearing.sql` | `settle_gateway_clearing(date, gross, fee, reference)` — the manual step for when a PayFast payout actually lands in the bank. Moves the gross amount out of 2450, into 1000 net of fee, expensing the fee to 7550. Never fires automatically — call it yourself against your PayFast merchant statement. |

Nothing moves out of Clearing on its own. That account only exists to hold gateway payments until you can point at a real bank statement line and settle it.

## Phase 2 add-on: rental_invoices posting + per-property export ✅

| File | What it does |
|---|---|
| `018_rental_invoice_posting.sql` | Wires the "Rent/Utility Invoice" direct-upload flow (non-10%-package properties) into the ledger — previously the only flow that DIDN'T post. Adds `tenant_id`/`discount`/`vat`/`posted_journal_id`/`posting_error` to `rental_invoices`, `rental_invoice_id` to `payments`, a new `2600 VAT Payable` account, and a posting trigger: Dr 1100 AR, Cr 4000 Rental Income (net of discount), Cr 6350 Utilities recoveries, Cr 2600 VAT Payable. |
| `019_property_filtered_trial_balance.sql` | Adds an optional `p_property_id` parameter to `get_period_trial_balance` (explicitly drops the old signature first — `create or replace` can't add a parameter without creating a duplicate overload). |

App changes: `admin-dashboard.js`'s Rent/Utility Invoice form now saves `tenant_id`/`discount`/`vat` onto `rental_invoices` and links the resulting `payments` row via `rental_invoice_id`. The Reports tab has a new **Property** dropdown next to Period — leave it on "All properties" for a portfolio-wide export, or pick one for a property-scoped trial balance + journal detail.

**Now covered, both invoicing flows post to the ledger:**
- "Generate Invoice" (10% package) → `tenant_invoices` → `011_tenant_invoice_posting.sql`
- "Rent/Utility Invoice" (everyone else) → `rental_invoices` → `018_rental_invoice_posting.sql`

## Phase 2 add-on: Levy Statement publishing + tenant recharge ✅

| File | What it does |
|---|---|
| `020_levy_recharge.sql` | Adds `levy_csos` to `rental_invoices` (kept separate from rent/electricity/water/sewerage/other_charges) and a new `6360 Levy Recoveries` account. Updates `post_rental_invoice_journal()` to post levy/CSOS to its own credit line. |

App changes: "Levy Statement" is now a category in the admin "Upload Document (Direct)" panel (publishes to `levy_statements`, owner-facing, same pattern as Owner Statement). It also has an optional checkbox — "Also invoice the tenant for this levy amount" — which, when checked with a tenant selected, creates a standalone recharge invoice (via `rental_invoices`/`payments`, same posting path as Rent/Utility Invoice) using the levy amount, kept as its own line rather than folded into utilities.

## What's next (Phase 3+, not built yet)

Payment channel differentiation (platform/manual/bank/cash/refund), bank + gateway reconciliation (clearing account → real bank), refunds/credit notes, capex classification, loan/bond tracking, period close/reopen, sub-ledgers and dashboards — per spec sections 9–51, in that order.
