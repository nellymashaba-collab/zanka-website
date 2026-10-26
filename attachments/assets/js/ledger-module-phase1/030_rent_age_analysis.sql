-- 030_rent_age_analysis.sql
-- Age analysis of rent invoiced and rental arrears (0–30, 31–60, 61–90,
-- 91–120, 120+ days) for admin, owners and partners linked to a property.
--
-- One function, rent_age_analysis(p_as_at), returns every rent charge
-- (a row in `payments`) with its property, tenant, invoice and payment
-- dates. The page age-analysis.html groups them into the buckets.
--
-- Who sees what (decided here, never in the browser):
--   admin   everything
--   owner   properties where properties.owner_id is them, or where
--           get_effective_owner_id() says they are the owner
--   partner properties they are assigned to (partner_property_assignments)
--   anyone else: nothing
--
-- "As at" a date: a charge counts if it was invoiced (or due) on or before
-- that date, and is outstanding at that date if it was unpaid then (still
-- Pending, or paid after that date). So month-end figures can be re-run
-- later and still give the same answer.
--
-- Run after 027. Safe to run again.

create or replace function public.rent_age_analysis(p_as_at date default null)
returns table (
  charge_id bigint,
  property_id bigint,
  property_name text,
  property_address text,
  tenant_id uuid,
  tenant_name text,
  invoice_number text,
  invoice_date date,
  due_date date,
  amount numeric,
  status text,
  paid_on date,
  outstanding numeric,
  days_overdue integer,
  days_since_invoice integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_admin boolean := public.is_admin();
  v_as_at date := coalesce(p_as_at, (now() at time zone 'Africa/Johannesburg')::date);
  v_has_effective_owner boolean := to_regprocedure('public.get_effective_owner_id(bigint)') is not null;
  v_has_assignments boolean := to_regclass('public.partner_property_assignments') is not null;
  v_props bigint[] := '{}';
begin
  if v_uid is null and not v_admin then
    raise exception 'Please log in.' using errcode = '42501';
  end if;

  -- The properties this person may see. (The optional parts only run when
  -- that table/function exists in this database.)
  if not v_admin then
    v_props := array(select pr.id from public.properties pr where pr.owner_id = v_uid);
    if v_has_effective_owner then
      begin
        v_props := v_props || array(select pr.id from public.properties pr where public.get_effective_owner_id(pr.id) = v_uid);
      exception when others then
        null; -- fall back to direct ownership only
      end;
    end if;
    if v_has_assignments then
      v_props := v_props || array(select a.property_id from public.partner_property_assignments a where a.partner_id = v_uid);
    end if;
  end if;

  return query
  with charges as (
    select p.id as c_id, p.tenant_id as c_tenant, p.amount::numeric as c_amount, p.due_date::date as c_due, p.status as c_status,
           coalesce(p.paid_date::date, (p.paid_at at time zone 'Africa/Johannesburg')::date) as c_paid,
           p.created_at as c_created,
           ti.id as ti_id, ri.id as ri_id,
           coalesce(ti.property_id, ri.property_id, mi.property_id,
                    (select ls.property_id from public.leases ls where ls.tenant_id = p.tenant_id
                      order by (ls.status in ('Active', 'Active_Month_to_Month')) desc, ls.start_date desc nulls last limit 1)) as c_property,
           coalesce(ti.invoice_number, mi.invoice_number) as c_invoice_no,
           coalesce(ti.invoice_date, ri.invoice_date, mi.invoice_date, (p.created_at at time zone 'Africa/Johannesburg')::date) as c_invoice_date
      from public.payments p
      left join public.tenant_invoices ti on ti.id = p.tenant_invoice_id
      left join public.rental_invoices ri on ri.id = p.rental_invoice_id
      -- Older charges were created without a link to their invoice: match
      -- the tenant's invoice with the same due date and amount.
      left join lateral (
        select t2.property_id, t2.invoice_number, t2.invoice_date from public.tenant_invoices t2
         where p.tenant_invoice_id is null and p.rental_invoice_id is null
           and t2.tenant_id = p.tenant_id and t2.due_date = p.due_date and abs(t2.total_due - p.amount) < 0.01
         order by t2.invoice_date desc limit 1
      ) mi on true
     where p.status in ('Pending', 'Paid')
  )
  select c.c_id, c.c_property, pr.name, pr.address, c.c_tenant, prof.full_name,
         c.c_invoice_no, c.c_invoice_date, c.c_due, c.c_amount, c.c_status,
         case when c.c_paid <= v_as_at then c.c_paid end,
         case when c.c_status = 'Pending' or c.c_paid > v_as_at then c.c_amount else 0 end,
         (v_as_at - coalesce(c.c_due, c.c_invoice_date))::integer,
         (v_as_at - c.c_invoice_date)::integer
    from charges c
    left join public.properties pr on pr.id = c.c_property
    left join public.profiles prof on prof.id = c.c_tenant
   where least(c.c_invoice_date, coalesce(c.c_due, c.c_invoice_date)) <= v_as_at
     and (v_admin or c.c_property = any (v_props))
   order by pr.name nulls last, prof.full_name nulls last, c.c_due;
end;
$$;

revoke all on function public.rent_age_analysis(date) from public, anon;
grant execute on function public.rent_age_analysis(date) to authenticated;
