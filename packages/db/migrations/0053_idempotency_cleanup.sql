-- 0053 Wiederholungsschlüssel aufräumen: every POST stores its full answer (documents with names
-- and addresses) under its Idempotency-Key. A repeat comes within minutes (double click, offline
-- outbox); after a day the row is only clutter and personal data outliving an erasure.
-- Worker job `notification.purge` (all companies, nightly).

CREATE INDEX IF NOT EXISTS idempotency_key_created_idx ON idempotency_key (created_at);

CREATE OR REPLACE FUNCTION purge_idempotency_keys(p_hours integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  removed integer;
BEGIN
  IF p_hours < 24 THEN
    RAISE EXCEPTION 'purge_idempotency_keys: at least 24 hours';
  END IF;
  DELETE FROM idempotency_key WHERE created_at < now() - make_interval(hours => p_hours);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $$;
REVOKE ALL ON FUNCTION purge_idempotency_keys(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_idempotency_keys(integer) TO opc_app;
