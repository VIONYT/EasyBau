-- Benachrichtigungen aufräumen: the worker deletes read notifications after a while, for all
-- companies (SECURITY DEFINER, like check_all_audit_chains). Notifications are no steuerrelevanten
-- data (only hints with a link). "Rechnung überfällig" stays: it is re-created from the invoice
-- list as long as the invoice is overdue (one row per invoice and person, UNIQUE), deleting it
-- would show it again as unread.
CREATE OR REPLACE FUNCTION purge_read_notifications(p_days integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  removed integer;
BEGIN
  IF p_days IS NULL OR p_days < 30 THEN
    RAISE EXCEPTION 'purge_read_notifications: at least 30 days';
  END IF;
  DELETE FROM notification
  WHERE read_at IS NOT NULL
    AND read_at < now() - make_interval(days => p_days)
    AND kind <> 'invoice_overdue';
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $$;
REVOKE ALL ON FUNCTION purge_read_notifications(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_read_notifications(integer) TO opc_app;
