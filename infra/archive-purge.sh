#!/bin/sh
# Löschen im Belegarchiv nach Fristende (C.12, migration 0047): removes the WORM copies of the
# originals of documents that were anonymised in „Prüfung › Aufbewahrung“ and whose Object Lock
# has ended, then marks them in the Löschprotokoll. Uses the RustFS root key from the volume
# "archive-keys" (the app never gets delete rights, ADR 0008/0009). Safe to repeat.
#   sh infra/archive-purge.sh            # delete
#   sh infra/archive-purge.sh --dry-run  # only list
# Run in the directory with compose.yaml and .env; other compose options via DC (see restore.sh).
# External S3 (compose.external-s3.yaml): there is no storage-setup service – remove the listed
# objects with your provider's tools (all versions), then mark them with the SQL at the end.
set -eu
DC=${DC:-docker compose}
psql() {
  $DC exec -T db sh -c 'psql -qAtX -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
}

due=$(echo "SELECT artifact_id || ' ' || storage_key FROM archive_purge_due();" | psql)
if [ -z "$due" ]; then
  echo "Keine Originale im Belegarchiv zu löschen."
  exit 0
fi
echo "$due" | sed 's/^[^ ]* /  /'
echo "$(echo "$due" | wc -l | tr -d ' ') Originale mit abgelaufener Sperrfrist von anonymisierten Belegen."
if [ "${1:-}" = "--dry-run" ]; then
  exit 0
fi

done_ids=$(echo "$due" | $DC run --rm -T --no-deps --entrypoint sh storage-setup /opt/storage/purge.sh \
  | sed -n 's/^ok //p')
count=0
for id in $done_ids; do
  echo "SELECT archive_purge_done('$id');" | psql >/dev/null
  count=$((count + 1))
done
echo "$count Originale aus dem Belegarchiv gelöscht und im Löschprotokoll vermerkt."
