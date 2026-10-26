-- 031_schema_snapshot.sql
-- Read-only, admin-only description of the database structure (tables,
-- columns, keys, relationships, row-level security) used to draw the
-- developer database diagram. Returns no data rows, only structure.
create or replace function public.admin_schema_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can read the schema.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'tables', (
      select jsonb_agg(jsonb_build_object(
        'name', c.relname,
        'kind', case c.relkind when 'v' then 'view' when 'm' then 'view' else 'table' end,
        'rls', c.relrowsecurity,
        'columns', (
          select jsonb_agg(jsonb_build_object(
            'name', a.attname,
            'type', format_type(a.atttypid, a.atttypmod),
            'nullable', not a.attnotnull,
            'default', pg_get_expr(d.adbin, d.adrelid)
          ) order by a.attnum)
          from pg_attribute a
          left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
          where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
        ),
        'pk', (
          select jsonb_agg(a.attname)
          from pg_constraint k join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
          where k.conrelid = c.oid and k.contype = 'p'
        ),
        'fks', (
          select jsonb_agg(jsonb_build_object(
            'columns', (select jsonb_agg(a.attname) from pg_attribute a where a.attrelid = k.conrelid and a.attnum = any (k.conkey)),
            'ref_table', rt.relname,
            'ref_schema', rn.nspname,
            'ref_columns', (select jsonb_agg(a.attname) from pg_attribute a where a.attrelid = k.confrelid and a.attnum = any (k.confkey))
          ))
          from pg_constraint k join pg_class rt on rt.oid = k.confrelid join pg_namespace rn on rn.oid = rt.relnamespace
          where k.conrelid = c.oid and k.contype = 'f'
        ),
        'policies', (select count(*) from pg_policy p where p.polrelid = c.oid)
      ) order by c.relname)
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
    ),
    'functions', (
      select jsonb_agg(jsonb_build_object('name', p.proname, 'args', pg_get_function_identity_arguments(p.oid), 'security_definer', p.prosecdef) order by p.proname)
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prokind = 'f'
    ),
    'buckets', (select jsonb_agg(jsonb_build_object('id', id, 'public', public) order by id) from storage.buckets)
  );
end;
$$;
revoke all on function public.admin_schema_snapshot() from public, anon;
grant execute on function public.admin_schema_snapshot() to authenticated;
