#!/bin/sh
# Belegarchiv (ADR 0009): removes the WORM copies of originals of anonymised documents (C.12,
# migration 0047) with the root key – the app key has no delete rights. Run by
# infra/archive-purge.sh in the service "storage-setup"; input on stdin: "<artifact id> <key>" per
# line (only objects whose lock has ended). Prints "ok <artifact id>" for every removed object.
# Object Lock still refuses anything locked; such objects are reported and stay.
set -eu
: "${ARCHIVE_S3_BUCKET:=belegarchiv}"
KEYS=${STORAGE_KEYS_DIR:-/keys}
ENDPOINT=${STORAGE_ENDPOINT:-http://storage:9000}
root_user=${STORAGE_ROOT_USER:-$(cat "$KEYS/root-user")}
root_secret=${STORAGE_ROOT_SECRET:-$(cat "$KEYS/root-secret")}
export RC_CONFIG_DIR="${TMPDIR:-/tmp}/rc"
mkdir -p "$RC_CONFIG_DIR"
export RC_HOST_root="${ENDPOINT%%://*}://${root_user}:${root_secret}@${ENDPOINT#*://}"

while read -r id key; do
  [ -n "${key:-}" ] || continue
  # All versions: the archive check may have written an object again (ADR 0008).
  if rc --quiet --no-color --no-progress object remove --versions --force \
       "root/$ARCHIVE_S3_BUCKET/$key" >/dev/null 2>"${TMPDIR:-/tmp}/rc-error"; then
    echo "ok $id"
  else
    echo "FEHLER $key: $(tr '\n' ' ' < "${TMPDIR:-/tmp}/rc-error")" >&2
  fi
done
