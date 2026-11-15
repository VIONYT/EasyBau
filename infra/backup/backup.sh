#!/bin/sh
# Backup service (ADR 0005): database (pg_dump, custom format) + Ablage (volume "files").
# Runs in the postgres image of the stack. Commands:
#   backup.sh daemon         wait for BACKUP_TIME every day and run a backup (container default)
#   backup.sh run            run a backup now
#   backup.sh list           list backups
#   backup.sh verify NAME    check checksums and readability of a backup
#   backup.sh restore NAME   replace database and Ablage with a backup (app must be stopped)
#   backup.sh offsite-list        backups in the encrypted copy off site (restic, ADR 0011)
#   backup.sh offsite-fetch NAME  fetch a backup from off site into /backups (then restore NAME)
#   backup.sh offsite-check       check the off-site repository (structure + 5 % of the data)
# Environment: PGHOST, PGUSER, PGPASSWORD, PGDATABASE, BACKUP_TIME (HH:MM or "off"),
# BACKUP_KEEP_DAYS, TZ. Target: /backups, Ablage: /data/files.
# Off site (optional): RESTIC_REPOSITORY, RESTIC_PASSWORD(_FILE), credentials of the target
# (e.g. AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, also as *_FILE), OFFSITE_KEEP_DAILY/WEEKLY/MONTHLY.
set -eu
umask 077 # backups contain personal and tax data

TARGET=/backups
FILES=/data/files
KEEP_DAYS=${BACKUP_KEEP_DAYS:-14}

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }

# Secrets also as *_FILE (Docker secrets), like the rest of the stack.
for var in RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY B2_ACCOUNT_KEY AZURE_ACCOUNT_KEY; do
  eval "file=\${${var}_FILE:-}"
  if [ -n "$file" ] && [ -z "$(eval "echo \${$var:-}")" ]; then
    [ -r "$file" ] || { log "${var}_FILE ist nicht lesbar: $file"; exit 1; }
    eval "export $var=\"\$(cat \"\$file\")\""
  fi
done
# Compose passes every variable, empty when not set: empty ones must not reach restic.
for var in RESTIC_PASSWORD_FILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SECRET_ACCESS_KEY_FILE \
  AWS_DEFAULT_REGION B2_ACCOUNT_ID B2_ACCOUNT_KEY; do
  [ -n "$(eval "echo \${$var:-}")" ] || unset "$var"
done
[ -z "${RESTIC_PASSWORD:-}" ] || unset RESTIC_PASSWORD_FILE
export RESTIC_CACHE_DIR=${RESTIC_CACHE_DIR:-$TARGET/.restic-cache}

offsite_enabled() { [ -n "${RESTIC_REPOSITORY:-}" ]; }

# restic with the SSH key and known_hosts from /run/offsite for sftp: targets (read-only mount;
# the host key must be known beforehand, nothing is accepted blindly).
restic() {
  if [ -f /run/offsite/id_ed25519 ]; then
    command restic -o "sftp.args=-i /run/offsite/id_ed25519 -o UserKnownHostsFile=/run/offsite/known_hosts -o StrictHostKeyChecking=yes" "$@"
  else
    command restic "$@"
  fi
}

# Target for the Betriebs-Check without credentials (user:password@ in REST/SFTP URLs).
offsite_target() { printf '%s' "${RESTIC_REPOSITORY:-}" | sed -E 's#//[^/@]*@#//#; s#^(sftp:)[^@]*@#\1#'; }

sql_quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"; }

record() { # status name started db_bytes files_bytes message
  psql -qtAX -v ON_ERROR_STOP=1 -c "insert into backup_run (status, name, started_at, db_bytes, files_bytes, message)
    values ($(sql_quote "$1"), $(sql_quote "$2"), $(sql_quote "$3"), nullif($(sql_quote "$4"), '')::bigint,
            nullif($(sql_quote "$5"), '')::bigint, nullif($(sql_quote "$6"), ''))" >/dev/null ||
    log "Konnte das Ergebnis nicht in der Datenbank vermerken."
}

size_of() { wc -c <"$1" | tr -d ' '; }

offsite_record() { # name status message
  psql -qtAX -v ON_ERROR_STOP=1 -c "update backup_run set offsite_status = $(sql_quote "$2"),
    offsite_at = now(), offsite_target = nullif($(sql_quote "$(offsite_target)"), ''),
    offsite_message = nullif($(sql_quote "$3"), '')
    where id = (select max(id) from backup_run where name = $(sql_quote "$1") and status = 'ok')" >/dev/null ||
    log "Konnte das Ergebnis der Sicherung außer Haus nicht vermerken."
}

# Encrypted copy off site (ADR 0011): restic encrypts on this server (AES-256), the target only
# sees encrypted data. Unchanged files are not transferred again (deduplication).
offsite() {
  name=$1
  if ! offsite_enabled; then
    offsite_record "$name" off ""
    return 0
  fi
  if [ -z "${RESTIC_PASSWORD:-}" ]; then
    offsite_record "$name" failed "RESTIC_PASSWORD fehlt."
    log "Sicherung außer Haus: RESTIC_PASSWORD fehlt."
    return 1
  fi
  log "Sicherung außer Haus nach $(offsite_target) beginnt."
  err="$TARGET/.$name.offsite.err"
  if {
    { restic cat config >/dev/null 2>&1 || restic init; } &&
      restic backup --host easybau --tag "$name" "$TARGET/$name" &&
      restic forget --host easybau --prune \
        --keep-daily "${OFFSITE_KEEP_DAILY:-14}" --keep-weekly "${OFFSITE_KEEP_WEEKLY:-8}" \
        --keep-monthly "${OFFSITE_KEEP_MONTHLY:-24}"
  } >/dev/null 2>"$err"; then
    rm -f "$err"
    offsite_record "$name" ok ""
    log "Sicherung außer Haus erfolgreich."
  else
    message=$(tail -c 400 "$err" 2>/dev/null | tr '\n' ' ' || true)
    rm -f "$err"
    offsite_record "$name" failed "${message:-Unbekannter Fehler}"
    log "Sicherung außer Haus fehlgeschlagen: $message"
    return 1
  fi
}

offsite_fetch() {
  name=$1
  offsite_enabled || { log "RESTIC_REPOSITORY ist nicht gesetzt."; return 1; }
  [ ! -e "$TARGET/$name" ] || { log "Die Sicherung $name liegt schon in $TARGET."; return 1; }
  log "Hole die Sicherung $name aus $(offsite_target)."
  restic restore latest --host easybau --tag "$name" --target / --include "$TARGET/$name"
  verify "$name"
  log "Sicherung $name geholt und geprüft. Wiederherstellen mit: sh infra/restore.sh $name"
}

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
    # A failed copy off site does not make the local backup fail; the Betriebs-Check warns.
    offsite "$name" || true
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
  # Archiv-Abgleich (ADR 0008): after a restore (possibly on a new server with an empty archive)
  # every archived original is checked and, if missing, written again from the Ablage.
  psql -qX -v ON_ERROR_STOP=1 -d "$db" <<'SQL'
DO $$ BEGIN
  IF to_regclass('public.archive_verify_request') IS NOT NULL THEN
    INSERT INTO archive_verify_request (tenant_id, reason)
    SELECT id, 'restore' FROM tenant
    ON CONFLICT (tenant_id) WHERE finished_at IS NULL DO NOTHING;
  END IF;
END $$;
SQL
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
  offsite-list)
    offsite_enabled || { log "RESTIC_REPOSITORY ist nicht gesetzt."; exit 1; }
    restic snapshots --host easybau --compact
    ;;
  offsite-fetch) offsite_fetch "${2:?Name der Sicherung fehlt}" ;;
  offsite-check)
    offsite_enabled || { log "RESTIC_REPOSITORY ist nicht gesetzt."; exit 1; }
    restic check --read-data-subset=5%
    ;;
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
    if offsite_enabled; then
      log "Danach verschlüsselte Kopie außer Haus nach $(offsite_target)."
    else
      log "Keine Sicherung außer Haus eingerichtet (RESTIC_REPOSITORY)."
    fi
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
    echo "Aufruf: backup.sh daemon|run|list|verify NAME|restore NAME|offsite-list|offsite-fetch NAME|offsite-check" >&2
    exit 2
    ;;
esac
