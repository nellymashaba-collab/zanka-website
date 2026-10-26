# Tenancy lifecycle: deployment notes

This covers notices to vacate, move-outs and deposits, lease-expiry and escalation notices, arrears, viewings and tenant account creation.

## What it adds

| Gap | What happens now |
|---|---|
| Notices to vacate went nowhere | A tenant's notice is stored with the lease and the legal earliest end date (20 business days, or one month on month-to-month). The tenant gets a copy, and admin and the owner are emailed. Admin acknowledges it on **Tenancies → Notices**, which opens a move-out case. |
| Deposits not tracked | **Tenancies → Deposits** keeps a per-lease ledger: the account it is held in, received, interest, deductions (a receipt is required) and the refund. The refund deadline is set from the inspection outcome: 7 days with no damage, 14 days after repairs, 21 days if the tenant didn't attend. |
| End-of-lease flow | **Tenancies → Move-outs**: book the joint inspection in the last 3 days (the tenant is emailed), record the outcome, settle the deposit, email the refund statement, create a draft re-listing and close. Closing marks the lease Expired and the unit Vacant, and tells the owner. In the Lease Manager, "Terminate" now opens a move-out instead of expiring the lease straight away. |
| Expiry and escalation notices never sent | Daily automation: a CPA expiry notice 40–80 business days before the end, with admin alerted if it goes out late. Leases that pass their end date roll over to month-to-month (tenant and owner emailed). Escalation notices go out at 90/60/30 days, and the new rent is applied on the effective date. |
| No arrears process | Reminders at 3 and 7 days overdue. At 14 days a **draft** letter of demand is prepared for admin to approve; nothing formal is sent automatically. Only payments due on or after the automation start date are automated, and older balances are listed as manual. |
| No viewing booking | **Tenant Recruitment → Viewings** on each listing: add times, see bookings with pre-qualification, and mark Attended or No-show. Attended applicants get an "apply now" email. The public listing page has a booking card plus confirmation, a reminder the day before and a cancel link. |
| Clunky tenant accounts | On an Accepted application, **Create tenant account now** makes the login from the application details and emails a set-password link to the tenant only. |

Every tenant and owner email cc's admin. Account set-up links are never cc'd.

## Deploy (in order)

1. **SQL.** Supabase → SQL Editor → paste and run `027_tenancy_lifecycle.sql`. It is safe to run again.
2. **Edge Function.** Edge Functions → Deploy a new function → Via editor. Name it `tenancy-automation` and paste `supabase/functions/tenancy-automation/index.ts`. It uses the existing `RESEND_API_KEY` secret.
3. **Daily schedule.** SQL Editor → run `028_tenancy_cron.sql`. This needs the pg_cron and pg_net extensions; the script enables them.
4. **Website.** Merge the pull request.
5. **Check.** Open **Tenancies → Emails & automation → Run daily checks now**. The amber "has not run yet" banner should clear.

## Settings

Change these under **Tenancies → Emails & automation**:
- Lease automation on/off
- Reminder days (3 / 7 / 14)
- Arrears automation start date (defaults to the day 027 was run)

The master email switch is still in **Tenant Recruitment → Screening settings**.

## Not included

Monthly invoicing and the PayFast webhook (gap 6) are unchanged. Payments are overdue when `payments.status = 'Pending'` and the due date has passed, so mark payments paid as you do today.

## Evidence of service (029)

Every tenancy email sent to a tenant or an owner is kept as a permanent evidence record. That covers letters of demand, reminders, notice acknowledgements, end-date confirmations, inspection notices, refund statements, and expiry, escalation and month-to-month notices. Each record holds:

- the exact email as sent (sender, recipients, cc, reply-to, subject, HTML and plain text)
- Resend's message ID and the time Resend accepted it
- delivery events reported by Resend's signed webhooks: sent, delivered, delayed, bounced, spam complaint
- a SHA-256 fingerprint of the content, and a hash chain linking each record to the one before it

The records are append-only. The database refuses updates, deletes and truncates for everyone, admins and the service role included. Only the Edge Functions can add records. **Tenancies → Emails & automation → Evidence register** re-checks every fingerprint and the whole chain. Each record opens as a printable "Evidence of service" page (Save as PDF / print), and each sent letter of demand has an **Evidence** button.

Viewing emails and account set-up emails are not kept: they go to applicants and contain private links.

### Deploy

1. SQL Editor: run `029_notice_evidence.sql`.
2. Edge Functions → `tenancy-automation` → replace the code with the new `supabase/functions/tenancy-automation/index.ts` → Deploy.
3. Edge Functions → Deploy a new function → name `email-events` → paste `supabase/functions/email-events/index.ts` → Deploy. Then open its settings and switch **off** "Verify JWT" (Resend can't log in; the function checks Resend's signature instead).
4. Resend → Webhooks → Add webhook:
   - Endpoint: `https://blhjlsddmwxjchjlfnhk.supabase.co/functions/v1/email-events`
   - Events: `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`
   - Copy the **Signing secret** (`whsec_…`).
5. Supabase → Edge Functions → Secrets → add `RESEND_WEBHOOK_SECRET` = that signing secret.

Emails sent before step 2 have no evidence record. The trail starts with the first notice sent afterwards.
