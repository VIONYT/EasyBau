#!/bin/sh
# Archiv-Abgleich (ADR 0008) for every company: the worker checks every archived original in the
# configured bucket and writes missing or damaged ones again (working copy, else the previous
# archive ARCHIVE_PREVIOUS_S3_*). Progress: Einstellungen › Betrieb › Betriebs-Check.
#   sh infra/archive-reconcile.sh
# Run in the directory with compose.yaml and .env; other compose options via DC (see restore.sh).
set -eu
DC=${DC:-docker compose}
$DC exec -T db sh -c 'psql -qX -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
INSERT INTO archive_verify_request (tenant_id, reason)
SELECT id, 'manual' FROM tenant
ON CONFLICT (tenant_id) WHERE finished_at IS NULL DO NOTHING;
SELECT count(*) AS "Firmen im Abgleich" FROM archive_verify_request WHERE finished_at IS NULL;
SQL
echo "Der Abgleich läuft im Hintergrund (Worker, etwa 200 Originale je 30 Sekunden)."
