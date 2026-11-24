#!/bin/sh
# Released migrations never change (ADR 0003, CLAUDE.md „Datenbank“): compared with the base
# revision, packages/db/migrations may only gain new files, numbered above the highest existing one.
# The migration runner would refuse to start on a changed checksum – this finds it before a release.
#
# Usage: sh infra/check-migrations.sh [base revision]
# Without a revision: the newest release tag v*, else origin/main.
set -eu

dir=packages/db/migrations
base=${1:-}
if [ -z "$base" ]; then
  base=$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || echo origin/main)
fi
if ! git rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
  echo "Basisstand $base nicht gefunden (git fetch --tags origin main?)." >&2
  exit 2
fi

status=0
changed=$(git diff --name-status --no-renames "$base" -- "$dir" | grep -v '^A' || true)
if [ -n "$changed" ]; then
  echo "Veröffentlichte Migrationen wurden geändert oder gelöscht (stattdessen eine neue Migration anlegen):" >&2
  echo "$changed" >&2
  status=1
fi

highest=$(git ls-tree --name-only "$base" "$dir/" | sed -n 's#.*/\([0-9]\{4\}\)_.*\.sql$#\1#p' | sort | tail -n 1)
for file in $(git diff --name-only --diff-filter=A "$base" -- "$dir"); do
  version=$(basename "$file" | cut -c1-4)
  if [ -n "$highest" ] && [ "$version" -le "$highest" ]; then
    echo "Neue Migration $file muss eine Nummer über $highest haben." >&2
    status=1
  fi
done

[ "$status" -eq 0 ] && echo "Migrationen gegenüber $base: nur neue Dateien (höchste bisher: ${highest:-keine})."
exit "$status"
