#!/bin/sh
# CI check: the archive (RustFS, ADR 0009) must be pinned to the same tag + digest in the stack and
# in the test pipeline, so the WORM tests always run against the version operators get. Fails if a
# (Dependabot) update changed only one of the files.
set -eu
cd "$(dirname "$0")/.."
refs=$(grep -hoE 'rustfs/rustfs:[^[:space:]"]+' compose.yaml compose.test.yaml | sort -u)
count=$(printf '%s\n' "$refs" | grep -c . || true)
for ref in $refs; do
  case "$ref" in
    *@sha256:*) ;;
    *) echo "FEHLER: $ref ist nicht per Digest gepinnt (Tag@sha256:…)." >&2; exit 1 ;;
  esac
done
if [ "$count" -ne 1 ]; then
  echo "FEHLER: compose.yaml und compose.test.yaml verwenden unterschiedliche RustFS-Versionen:" >&2
  printf '  %s\n' $refs >&2
  echo "Bitte in beiden Dateien denselben Tag + Digest eintragen." >&2
  exit 1
fi
echo "RustFS einheitlich gepinnt: $refs"
