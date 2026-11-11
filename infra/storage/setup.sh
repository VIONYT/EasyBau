#!/bin/sh
# Belegarchiv mit RustFS (ADR 0009), runs once per start in the service "storage-setup":
#   1. bucket with Object Lock (and versioning) – never changed once it exists,
#   2. policy "belegarchiv-app": write once, read, set retention; no delete, no bucket changes,
#      no governance bypass,
#   3. user for the app (ARCHIVE_S3_ACCESS_KEY/ARCHIVE_S3_SECRET_KEY) with only this policy.
# The root key stays in the volume "archive-keys"; the app never gets it. Idempotent.
set -eu
if [ -z "${ARCHIVE_S3_SECRET_KEY:-}" ] && [ -n "${ARCHIVE_S3_SECRET_KEY_FILE:-}" ]; then
  ARCHIVE_S3_SECRET_KEY=$(cat "$ARCHIVE_S3_SECRET_KEY_FILE")
fi
: "${ARCHIVE_S3_BUCKET:=belegarchiv}"
: "${ARCHIVE_S3_ACCESS_KEY:?ARCHIVE_S3_ACCESS_KEY fehlt}"
: "${ARCHIVE_S3_SECRET_KEY:?ARCHIVE_S3_SECRET_KEY fehlt}"
KEYS=${STORAGE_KEYS_DIR:-/keys}
ENDPOINT=${STORAGE_ENDPOINT:-http://storage:9000}

# Root key from the keys volume (stack) or from the environment (test pipeline).
root_user=${STORAGE_ROOT_USER:-$(cat "$KEYS/root-user")}
root_secret=${STORAGE_ROOT_SECRET:-$(cat "$KEYS/root-secret")}
if [ "$ARCHIVE_S3_ACCESS_KEY" = "$root_user" ]; then
  echo "FEHLER: ARCHIVE_S3_ACCESS_KEY darf nicht der Root-Zugang sein." >&2
  exit 1
fi
export RC_CONFIG_DIR="${TMPDIR:-/tmp}/rc"
mkdir -p "$RC_CONFIG_DIR"
export RC_HOST_root="${ENDPOINT%%://*}://${root_user}:${root_secret}@${ENDPOINT#*://}"
rc="rc --quiet --no-color --no-progress"

$rc bucket create "root/$ARCHIVE_S3_BUCKET" --with-lock --with-versioning --ignore-existing

policy="${TMPDIR:-/tmp}/belegarchiv-app.json"
sed "s/BUCKET/$ARCHIVE_S3_BUCKET/g" /opt/storage/app-policy.json > "$policy"
$rc admin policy create root belegarchiv-app "$policy"

# Adding an existing user updates its secret (e.g. after changing ARCHIVE_S3_SECRET_KEY).
$rc admin user add root "$ARCHIVE_S3_ACCESS_KEY" "$ARCHIVE_S3_SECRET_KEY"
$rc admin policy attach root belegarchiv-app --user "$ARCHIVE_S3_ACCESS_KEY" 2>/dev/null || true
echo "Belegarchiv bereit: Bucket $ARCHIVE_S3_BUCKET mit Object Lock, App-Zugang $ARCHIVE_S3_ACCESS_KEY (ohne Löschrecht)."
