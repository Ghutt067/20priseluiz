-- Patch: Hardening de segurança/performance para Supabase (RLS + funções + índices FK)
-- Aplicado no projeto em 2026-02-14 via migrations MCP:
-- 1) hardening_rls_and_function_search_path_v2
-- 2) add_missing_foreign_key_indexes
-- 3) optimize_organizations_select_policy
-- 4) move_text_extensions_to_extensions_schema

-- ==========================================================
-- 1) Segurança: fixar search_path de funções (linter 0011)
-- ==========================================================
DO $$
BEGIN
  IF to_regprocedure('public.current_org_id()') IS NOT NULL THEN
    EXECUTE 'alter function public.current_org_id() set search_path = public, pg_temp';
  END IF;

  IF to_regprocedure('public.is_org_member(uuid)') IS NOT NULL THEN
    EXECUTE 'alter function public.is_org_member(uuid) set search_path = public, pg_temp';
  END IF;

  IF to_regprocedure('public.has_org_access(uuid)') IS NOT NULL THEN
    EXECUTE 'alter function public.has_org_access(uuid) set search_path = public, pg_temp';
  END IF;

  IF to_regprocedure('public.is_org_admin(uuid)') IS NOT NULL THEN
    EXECUTE 'alter function public.is_org_admin(uuid) set search_path = public, pg_temp';
  END IF;

  IF to_regprocedure('public.set_updated_at()') IS NOT NULL THEN
    EXECUTE 'alter function public.set_updated_at() set search_path = public, pg_temp';
  END IF;

  IF to_regprocedure('public.prevent_audit_log_changes()') IS NOT NULL THEN
    EXECUTE 'alter function public.prevent_audit_log_changes() set search_path = public, pg_temp';
  END IF;

  IF to_regprocedure('public.set_products_search()') IS NOT NULL THEN
    EXECUTE 'alter function public.set_products_search() set search_path = public, extensions, pg_temp';
  END IF;
END
$$;

-- ==========================================================
-- 2) Performance RLS: evitar reavaliação por linha (linter 0003)
-- ==========================================================
-- profiles
DROP POLICY IF EXISTS profiles_select ON public.profiles;
DROP POLICY IF EXISTS profiles_update ON public.profiles;
DROP POLICY IF EXISTS profiles_insert ON public.profiles;

CREATE POLICY profiles_select ON public.profiles
FOR SELECT
USING ((id = (SELECT auth.uid())) OR is_org_admin(organization_id));

CREATE POLICY profiles_update ON public.profiles
FOR UPDATE
USING ((id = (SELECT auth.uid())) OR is_org_admin(organization_id))
WITH CHECK ((id = (SELECT auth.uid())) OR is_org_admin(organization_id));

CREATE POLICY profiles_insert ON public.profiles
FOR INSERT
WITH CHECK (id = (SELECT auth.uid()));

-- organization_users (mantém escrita só para admin)
DROP POLICY IF EXISTS org_users_select ON public.organization_users;

CREATE POLICY org_users_select ON public.organization_users
FOR SELECT
USING ((user_id = (SELECT auth.uid())) OR is_org_member(organization_id));

-- organizations
DROP POLICY IF EXISTS organizations_select ON public.organizations;

CREATE POLICY organizations_select ON public.organizations
FOR SELECT
USING (
  EXISTS (
    SELECT 1
    FROM public.organization_users ou
    WHERE ou.organization_id = organizations.id
      AND ou.user_id = (SELECT auth.uid())
  )
);

-- ==========================================================
-- 3) Performance: criar índices faltantes de FK (linter 0001)
-- ==========================================================
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT
      format(
        'create index if not exists %I on %I.%I (%s)',
        left('idx_fk_' || c.oid::text || '_' || rel.relname, 63),
        ns.nspname,
        rel.relname,
        string_agg(format('%I', att.attname), ', ' ORDER BY u.ord)
      ) AS ddl
    FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord) ON true
    JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = u.attnum
    WHERE c.contype = 'f'
      AND ns.nspname = 'public'
      AND NOT EXISTS (
        SELECT 1
        FROM pg_index i
        WHERE i.indrelid = c.conrelid
          AND i.indisvalid
          AND i.indisready
          AND (i.indkey::smallint[])[0:cardinality(c.conkey)-1] = c.conkey
      )
    GROUP BY c.oid, ns.nspname, rel.relname
    ORDER BY ns.nspname, rel.relname
  LOOP
    EXECUTE rec.ddl;
  END LOOP;
END
$$;

-- ==========================================================
-- 4) Segurança: mover extensões de busca para schema extensions
-- ==========================================================
CREATE SCHEMA IF NOT EXISTS extensions;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'unaccent'
      AND n.nspname = 'public'
  ) THEN
    EXECUTE 'alter extension unaccent set schema extensions';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'pg_trgm'
      AND n.nspname = 'public'
  ) THEN
    EXECUTE 'alter extension pg_trgm set schema extensions';
  END IF;
END
$$;

-- ==========================================================
-- Pendências que não são alteráveis via SQL puro no fluxo atual:
-- - auth_leaked_password_protection (configuração do Supabase Auth)
-- ==========================================================
