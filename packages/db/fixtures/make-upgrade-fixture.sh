#!/bin/sh
# Writes packages/db/fixtures/upgrade-NNNN.sql: a data dump of a database at the newest migration,
# filled through the API (apps/api/src/upgrade-fixture.generate.integration.test.ts).
#
# Usage (repository root, with a PostgreSQL 17 in Docker as for the integration tests):
#   DATABASE_URL=postgres://opc:opc@127.0.0.1:55432/opc PG_CONTAINER=opc-pg-schema \
#     sh packages/db/fixtures/make-upgrade-fixture.sh
set -eu

: "${DATABASE_URL:?DATABASE_URL fehlt}"
: "${PG_CONTAINER:?PG_CONTAINER fehlt (Container mit pg_dump 17)}"
user=$(printf '%s' "$DATABASE_URL" | sed -E 's#^postgres(ql)?://([^:@/]+).*#\2#')
version=$(ls packages/db/migrations | sed -n 's/^\([0-9]\{4\}\)_.*\.sql$/\1/p' | sort | tail -n 1)
marker=$(mktemp)

UPGRADE_FIXTURE_OUT="$marker" pnpm vitest run apps/api/src/upgrade-fixture.generate.integration.test.ts
database=$(cat "$marker")
rm -f "$marker"
[ -n "$database" ] || { echo "Generator hat keine Datenbank hinterlassen." >&2; exit 1; }

out="packages/db/fixtures/upgrade-$version.sql"
docker exec "$PG_CONTAINER" pg_dump -U "$user" -d "$database" --data-only --column-inserts \
  --disable-triggers --schema=public --exclude-table=public.schema_migration \
  --no-owner --no-privileges 2>/dev/null |
  grep -v '^\\' >"$out"
docker exec "$PG_CONTAINER" psql -U "$user" -d postgres -qc "drop database if exists $database with (force)"
echo "$out geschrieben ($(grep -c '^INSERT' "$out") Datensätze)."
