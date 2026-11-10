#!/bin/sh
# Backup service (ADR 0005): database (pg_dump, custom format) + Ablage (volume "files").
# Runs in the postgres image of the stack. Commands:
#   backup.sh daemon         wait for BACKUP_TIME every day and run a backup (container default)
#   backup.sh run            run a backup now
#   backup.sh list           list backups
#   backup.sh verify NAME    check checksums and readability of a backup
#   backup.sh restore NAME   replace database and Ablage with a backup (app must be stopped)
# Environment: PGHOST, PGUSER, PGPASSWORD, PGDATABASE, BACKUP_TIME (HH:MM or "off"),
# BACKUP_KEEP_DAYS, TZ. Target: /backups, Ablage: /data/files.
set -eu
umask 077 # backups contain personal and tax data

TARGET=/backups
FILES=/data/files
KEEP_DAYS=${BACKUP_KEEP_DAYS:-14}

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }

sql_quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"; }

record() { # status name started db_bytes files_bytes message
  psql -qtAX -v ON_ERROR_STOP=1 -c "insert into backup_run (status, name, started_at, db_bytes, files_bytes, message)
    values ($(sql_quote "$1"), $(sql_quote "$2"), $(sql_quote "$3"), nullif($(sql_quote "$4"), '')::bigint,
            nullif($(sql_quote "$5"), '')::bigint, nullif($(sql_quote "$6"), ''))" >/dev/null ||
    log "Konnte das Ergebnis nicht in der Datenbank vermerken."
}

size_of() { wc -c <"$1" | tr -d ' '; }

verify() {
  dir="$TARGET/$1"
  [ -f "$dir/SHA256SUMS" ] || { log "Keine Sicherung mit dem Namen $1."; return 1; }
  (cd "$dir" && sha256sum -c -s SHA256SUMS) || { log "Prüfsummen stimmen nicht: $1"; return 1; }
  pg_restore --list "$dir/db.dump" >/dev/null
  tar -tzf "$dir/files.tar.gz" >/dev/null
}

run_backup() {
  name=$(date +%Y-%m-%d_%H%M%S)
  started=$(date -Iseconds)
  work="$TARGET/.$name.partial"
  mkdir -p "$work"
  log "Sicherung $name beginnt."
  # Database first, then files: a file uploaded in between is only extra, never missing.
  if {
    pg_dump --format=custom --compress=6 --file="$work/db.dump" &&
      tar -czf "$work/files.tar.gz" -C "$FILES" . &&
      (cd "$work" && sha256sum db.dump files.tar.gz >SHA256SUMS) &&
      mv "$work" "$TARGET/$name" &&
      verify "$name"
  } 2>"$TARGET/.$name.err"; then
    rm -f "$TARGET/.$name.err"
    record ok "$name" "$started" "$(size_of "$TARGET/$name/db.dump")" \
      "$(size_of "$TARGET/$name/files.tar.gz")" ""
    log "Sicherung $name erfolgreich."
    # Old backups are removed only after a successful one, so the newest good backup stays.
    find "$TARGET" -mindepth 1 -maxdepth 1 -type d -name '20*' -mtime +"$KEEP_DAYS" \
      -exec rm -rf {} + -exec echo "Alte Sicherung entfernt:" {} \;
  else
    message=$(tail -c 500 "$TARGET/.$name.err" 2>/dev/null || true)
    rm -rf "$work" "$TARGET/$name" "$TARGET/.$name.err"
    record failed "$name" "$started" "" "" "${message:-Unbekannter Fehler}"
    log "Sicherung $name fehlgeschlagen: $message"
    return 1
  fi
}

restore() {
  name=$1
  verify "$name"
  dir="$TARGET/$name"
  db=${PGDATABASE:?}
  log "Stelle Datenbank $db aus $name wieder her."
  psql -qX -v ON_ERROR_STOP=1 -d postgres -v db="$db" <<'SQL'
SELECT format('DROP DATABASE IF EXISTS %I WITH (FORCE)', :'db') \gexec
SELECT format('CREATE DATABASE %I', :'db') \gexec
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'opc_app') THEN
    CREATE ROLE opc_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
SQL
  pg_restore --no-owner --exit-on-error --dbname="$db" "$dir/db.dump"
  log "Stelle die Ablage wieder her."
  find "$FILES" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  tar -xzf "$dir/files.tar.gz" -C "$FILES"
  # The restored log ends before this backup; note it so the Betriebs-Check knows it exists.
  record ok "$name" "$(date -Iseconds)" "$(size_of "$dir/db.dump")" "$(size_of "$dir/files.tar.gz")" \
    "Wiederhergestellt am $(date '+%d.%m.%Y %H:%M')"
  log "Wiederherstellung aus $name abgeschlossen."
}

case "${1:-daemon}" in
  run) run_backup ;;
  list)
    for d in "$TARGET"/20*; do
      [ -d "$d" ] || continue
      echo "$(basename "$d")  $(du -sh "$d" | cut -f1)"
    done
    ;;
  verify) verify "${2:?Name der Sicherung fehlt}" && log "Sicherung $2 ist lesbar und vollständig." ;;
  restore) restore "${2:?Name der Sicherung fehlt}" ;;
  daemon)
    time=${BACKUP_TIME:-02:30}
    if [ "$time" = off ]; then
      log "Automatische Sicherung ist ausgeschaltet (BACKUP_TIME=off)."
      exec sleep infinity
    fi
    echo "$time" | grep -Eq '^([01][0-9]|2[0-3]):[0-5][0-9]$' || {
      log "BACKUP_TIME muss HH:MM oder off sein, ist aber: $time"
      exit 1
    }
    log "Tägliche Sicherung um $time ($(date +%Z)), Aufbewahrung $KEEP_DAYS Tage, Ziel $TARGET."
    last=""
    while :; do
      today=$(date +%F)
      if [ "$(date +%H:%M)" = "$time" ] && [ "$last" != "$today" ]; then
        last=$today
        # Fresh shell: picks up an updated script without restarting the container.
        sh "$0" run || true
      fi
      sleep 30
    done
    ;;
  *)
    echo "Aufruf: backup.sh daemon|run|list|verify NAME|restore NAME" >&2
    exit 2
    ;;
esac
