-- 0014 Backup log: the backup service (ADR 0005) records every run here so the application can
-- show the backup state under Einstellungen › Betrieb. Installation-wide operational data like
-- schema_migration, not business data of a company: no tenant_id, readable by the application.

CREATE TABLE IF NOT EXISTS backup_run (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL,
  status      text NOT NULL CHECK (status IN ('ok', 'failed')),
  started_at  timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT now(),
  db_bytes    bigint,
  files_bytes bigint,
  message     text
);
CREATE INDEX IF NOT EXISTS backup_run_finished_idx ON backup_run (finished_at DESC);

REVOKE ALL ON backup_run FROM PUBLIC;
GRANT SELECT ON backup_run TO opc_app;
