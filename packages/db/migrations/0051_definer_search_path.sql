-- 0051 SECURITY DEFINER functions run with the owner's rights. With search_path = public alone,
-- PostgreSQL still searches pg_temp first, so a session with TEMP rights (opc_app) could shadow a
-- table with a temporary one (security audit run-1). pg_temp goes explicitly to the end.
-- New definer functions: SET search_path = public, pg_temp.
DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', f.signature);
  END LOOP;
END $$;
