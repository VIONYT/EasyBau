#!/bin/sh
# Restores a backup of the backup service: database and Ablage are REPLACED.
#   sh infra/restore.sh                 list backups
#   sh infra/restore.sh NAME [--yes]    restore backup NAME (e.g. 2026-11-09_023000)
# Run in the directory with compose.yaml and .env. Other compose options via DC, e.g.
#   DC="docker compose --env-file /etc/openplancraft.env" sh infra/restore.sh NAME
# The .env must contain the same APP_SECRET as at the time of the backup (2FA, IBAN).
set -eu
DC=${DC:-docker compose}
name=${1:-}

$DC up -d db backup >/dev/null
if [ -z "$name" ]; then
  echo "Vorhandene Sicherungen:"
  $DC exec -T backup sh /opt/backup/backup.sh list
  echo "Wiederherstellen mit: sh infra/restore.sh <Name>"
  exit 0
fi

$DC exec -T backup sh /opt/backup/backup.sh verify "$name"

if [ "${2:-}" != "--yes" ]; then
  printf 'Datenbank und Ablage werden durch die Sicherung %s ERSETZT.\nZum Fortfahren "wiederherstellen" eingeben: ' "$name"
  read -r answer
  [ "$answer" = "wiederherstellen" ] || { echo "Abgebrochen."; exit 1; }
fi

echo "Anwendung wird angehalten …"
$DC stop proxy app >/dev/null
$DC --profile standard stop worker >/dev/null 2>&1 || true

$DC exec -T backup sh /opt/backup/backup.sh restore "$name"

echo "Anwendung wird gestartet (Migrationen laufen automatisch) …"
$DC up -d
echo "Fertig. Bitte anmelden und Stichproben prüfen (Projekte, Dokumente, Dateien)."
