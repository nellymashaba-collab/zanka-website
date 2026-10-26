-- ============================================================================
-- ZANKA TENANT RECRUITMENT — LISTING PHOTOS
-- 025_listing_photos.sql   (run after 024_tenant_recruitment.sql)
--
-- * rental_vacancies.photos: ordered list of photos; the first is the cover.
--   [{ "path": "<vacancy_id>/<file>.jpg", "width": 1600, "height": 1200 }, ...]
-- * Public storage bucket 'listing-photos'. Listing photos are meant to be
--   seen by anyone, so they are served from public URLs. Only admins can
--   upload, replace or delete them. (Applicants' documents stay in the
--   separate PRIVATE 'rental-applications' bucket — nothing changes there.)
-- * list_open_rental_vacancies() now also returns photos.
--
-- Safe to re-run. If you ever re-run 024, run this file again afterwards.
-- ============================================================================

alter table public.rental_vacancies
  add column if not exists photos jsonb not null default '[]'::jsonb;

alter table public.rental_vacancies drop constraint if exists rental_vacancies_photos_shape;
alter table public.rental_vacancies add constraint rental_vacancies_photos_shape
  check (jsonb_typeof(photos) = 'array' and jsonb_array_length(photos) <= 20);


-- Public bucket: images only, 5 MB each (the admin page shrinks photos to
-- about 300 KB before upload, so this is a safety limit, not the norm).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
select 'listing-photos', 'listing-photos', true, 5242880,
       array['image/jpeg', 'image/png', 'image/webp']
where not exists (select 1 from storage.buckets where id = 'listing-photos');

drop policy if exists "Admins manage listing-photos" on storage.objects;
create policy "Admins manage listing-photos" on storage.objects
  for all using (bucket_id = 'listing-photos' and is_admin())
  with check (bucket_id = 'listing-photos' and is_admin());
-- No other policy: anonymous visitors read photos through the bucket's
-- public URLs, but cannot upload, overwrite, delete or list files.


-- Same function as in 024, plus photos. The return type changes, so it has
-- to be dropped and recreated rather than replaced.
drop function if exists public.list_open_rental_vacancies();
create function public.list_open_rental_vacancies()
returns table (
  id uuid, title text, area text, description text,
  bedrooms integer, bathrooms numeric, parking_bays integer, max_occupants integer,
  pets_policy text, features text[], monthly_rent numeric, deposit numeric,
  available_from date, applications_close_at timestamptz, min_gross_income numeric,
  photos jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select v.id, v.title, v.area, v.description,
         v.bedrooms, v.bathrooms, v.parking_bays, v.max_occupants,
         v.pets_policy, v.features, v.monthly_rent, v.deposit,
         v.available_from, v.applications_close_at,
         ceil(v.monthly_rent / s.affordability_knockout_max) as min_gross_income,
         v.photos
  from public.rental_vacancies v
  cross join (select affordability_knockout_max from public.rental_recruitment_settings order by updated_at desc limit 1) s
  where v.status = 'Open'
    and (v.applications_close_at is null or v.applications_close_at > now())
  order by v.available_from nulls last, v.created_at;
$$;

revoke all on function public.list_open_rental_vacancies() from public;
grant execute on function public.list_open_rental_vacancies() to anon, authenticated;
