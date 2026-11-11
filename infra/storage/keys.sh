#!/bin/sh
# Creates the root key of the bundled RustFS once (volume "archive-keys"); it never leaves the
# storage services. Show it if needed: docker compose exec storage cat /keys/root-secret
set -eu
KEYS=${STORAGE_KEYS_DIR:-/keys}
if [ ! -s "$KEYS/root-secret" ]; then
  umask 077
  echo "archiv-root" > "$KEYS/root-user"
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$KEYS/root-secret"
  echo "Root-Schlüssel für das Belegarchiv erzeugt."
fi
chown -R 10001:10001 "$KEYS"
chmod 0400 "$KEYS/root-user" "$KEYS/root-secret"
