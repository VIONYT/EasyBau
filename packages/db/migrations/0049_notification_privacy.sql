-- 0049 Notifications are derived copies (customer name, open amount) and go with the data they
-- were made from (security audit run-1): when a finalized document is anonymised after its
-- retention period (0047) or a contact is erased (0039/0042), the notifications that refer to
-- these documents are deleted. Runs as the caller, within the tenant (RLS of notification).

CREATE OR REPLACE FUNCTION notification_forget_document() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM notification WHERE ref_id = NEW.id;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS notification_forget_document ON document;
CREATE TRIGGER notification_forget_document
  AFTER UPDATE OF purged_at ON document
  FOR EACH ROW WHEN (OLD.purged_at IS NULL AND NEW.purged_at IS NOT NULL)
  EXECUTE FUNCTION notification_forget_document();

CREATE OR REPLACE FUNCTION notification_forget_contact() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM notification
  WHERE ref_id IN (SELECT d.id FROM document d
                   WHERE d.contact_id = NEW.id OR d.contact_person_id = NEW.id);
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS notification_forget_contact ON contact;
CREATE TRIGGER notification_forget_contact
  AFTER UPDATE OF erased_at ON contact
  FOR EACH ROW WHEN (OLD.erased_at IS NULL AND NEW.erased_at IS NOT NULL)
  EXECUTE FUNCTION notification_forget_contact();
