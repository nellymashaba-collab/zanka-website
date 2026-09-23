-- ============================================================================
-- ZANKA LEDGER MODULE — PHASE 1 (revised — confirmed columns)
-- 008_resolve_legacy_references.sql
--
-- Confirmed: properties.address, profiles.full_name, profiles.role exist
-- with those names. Run the SELECT at the bottom after this to eyeball
-- matches before running 009.
-- ============================================================================

create table if not exists public.stg_legacy_ref_map (
  legacy_code text primary key,
  entity_type text not null check (entity_type in ('property','tenant','lease')),
  resolved_id text,
  match_basis text,
  confirmed   boolean not null default false
);

insert into public.stg_legacy_ref_map (legacy_code, entity_type, match_basis) values
  ('P-001', 'property', 'address ilike %Petervale%'),
  ('P-002', 'property', 'address ilike %Kensington%'),
  ('T-001', 'tenant', 'full_name ilike %Karabo%Tshoke%'),
  ('T-002', 'tenant', 'full_name ilike %Jordan%Pieters%'),
  ('L-001', 'lease', 'derived from resolved P-001 + T-001'),
  ('L-002', 'lease', 'derived from resolved P-002 + T-002')
on conflict (legacy_code) do nothing;

update public.stg_legacy_ref_map m
set resolved_id = p.id::text
from public.properties p
where m.legacy_code = 'P-001' and p.address ilike '%Petervale%';

update public.stg_legacy_ref_map m
set resolved_id = p.id::text
from public.properties p
where m.legacy_code = 'P-002' and p.address ilike '%Kensington%';

update public.stg_legacy_ref_map m
set resolved_id = pr.id::text
from public.profiles pr
where m.legacy_code = 'T-001' and pr.full_name ilike '%Karabo%Tshoke%';

update public.stg_legacy_ref_map m
set resolved_id = pr.id::text
from public.profiles pr
where m.legacy_code = 'T-002' and pr.full_name ilike '%Jordan%Pieters%';

update public.stg_legacy_ref_map m
set resolved_id = l.id::text
from public.leases l
where m.legacy_code = 'L-001'
  and l.property_id = (select resolved_id::bigint from public.stg_legacy_ref_map where legacy_code = 'P-001')
  and l.tenant_id = (select resolved_id::uuid from public.stg_legacy_ref_map where legacy_code = 'T-001');

update public.stg_legacy_ref_map m
set resolved_id = l.id::text
from public.leases l
where m.legacy_code = 'L-002'
  and l.property_id = (select resolved_id::bigint from public.stg_legacy_ref_map where legacy_code = 'P-002')
  and l.tenant_id = (select resolved_id::uuid from public.stg_legacy_ref_map where legacy_code = 'T-002');

-- ⚠ STOP AND CHECK THIS before running 009 — if any resolved_id is NULL,
-- that legacy code found no match and those lines will import without a
-- property/tenant/lease tag (the amounts still post correctly either way).
select * from public.stg_legacy_ref_map order by legacy_code;

-- Once you've reviewed the above and it looks right, mark them confirmed:
update public.stg_legacy_ref_map set confirmed = true where resolved_id is not null;
