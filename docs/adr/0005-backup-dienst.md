# ADR 0005: Backup-Dienst im Stack mit dem PostgreSQL-Image

- Status: angenommen
- Datum: 2026-11-09
- Ergänzt: ADR 0002 (schlanker Stack), ADR 0004 (Dateiablage)

## Kontext
Betriebe betreiben die Software selbst und haben meist keine IT-Abteilung. Ohne automatische Sicherung gehen bei einem Plattendefekt Rechnungen, Aufmaße und Fotos verloren; Rechnungen müssen zehn Jahre aufbewahrt werden. Gesichert werden müssen **Datenbank und Volume `files` gemeinsam** (ADR 0004). Laut CLAUDE.md braucht ein neuer Container ein ADR und soll wenig Speicher brauchen.

Geprüfte Alternativen:
- Cronjob auf dem Host: hängt vom Betriebssystem ab, wird vergessen, ist nicht Teil von `docker compose up`.
- Sicherung durch den Worker (Node.js): bräuchte `pg_dump` im App-Image (größer, andere PostgreSQL-Version als die Datenbank möglich) und Schreibrechte auf das Sicherungsziel im App-Container.
- Spezialisierte Werkzeuge (restic, borg, pgBackRest) als eigenes Image: mehr Funktionen (Verschlüsselung, Deduplizierung, Point-in-Time), aber zusätzliches Image und mehr Einarbeitung für Betreiber. Bleiben als Ergänzung für die Kopie außer Haus möglich.

## Entscheidung
1. Neuer Dienst **`backup`** im Standard-Stack (beide Profile). Er nutzt **dasselbe Image wie `db`** (`postgres:17-alpine`): kein zusätzlicher Download, `pg_dump` passt immer zur Serverversion. Das Skript `infra/backup/backup.sh` wird schreibgeschützt eingehängt; der Container ist `read_only`.
2. Täglich zur Uhrzeit `BACKUP_TIME` (Zeitzone `TZ`, Standard 02:30 Europe/Berlin; `off` schaltet ab) entsteht ein Verzeichnis `JJJJ-MM-TT_HHMMSS` mit `db.dump` (`pg_dump` Custom-Format, konsistenter Schnappschuss), `files.tar.gz` (Ablage) und `SHA256SUMS`. Zuerst die Datenbank, dann die Dateien: eine zwischendurch hochgeladene Datei ist höchstens überzählig, nie fehlend.
3. Jede Sicherung wird nach dem Schreiben **geprüft** (Prüfsummen, `pg_restore --list`, `tar -t`). Erst danach gilt sie als erfolgreich; alte Sicherungen (älter als `BACKUP_KEEP_DAYS`) werden nur nach einer erfolgreichen Sicherung gelöscht.
4. Ziel ist `BACKUP_DIR`: ein Docker-Volume `backups` (Standard) oder ein Pfad auf dem Server, z. B. ein eingehängtes NAS.
5. Jeder Lauf wird in der Tabelle **`backup_run`** vermerkt (Migration 0014). Sie ist Betriebsdatum der Installation wie `schema_migration`, keine Fachtabelle: ohne `tenant_id` und RLS, die Anwendung (`opc_app`) darf nur lesen. Einstellungen › Betrieb zeigt daraus den Betriebs-Check (Warnung, wenn die letzte erfolgreiche Sicherung älter als 26 Stunden ist).
6. Wiederherstellen mit `infra/restore.sh NAME`: prüft die Sicherung, fragt nach, hält Proxy, App und Worker an, ersetzt Datenbank und Ablage und startet den Stack; Migrationen laufen danach automatisch.

## Konsequenzen
- Ein zusätzlicher Container mit einer Shell-Schleife: im Leerlauf wenige MB RAM, während der Sicherung kurz CPU und Platten-I/O.
- Der Dienst kennt das Datenbank-Passwort des Eigentümers und hat Schreibzugriff auf die Ablage (nur für die Wiederherstellung). Er öffnet keinen Port.
- Die Sicherung ist **nicht verschlüsselt** und liegt standardmäßig auf demselben Server. Betreiber müssen sie auf ein zweites Gerät kopieren (Anleitung in `docs/self-hosting`); die `.env` mit `APP_SECRET` gehört getrennt dazu, sonst sind 2FA-Geheimnisse und IBAN nach einer Wiederherstellung nicht lesbar.
- Die Sicherungen sind nicht unveränderbar (kein WORM). Das revisionssichere Archiv festgeschriebener Belege bleibt Aufgabe des Archivspeichers mit Object Lock (ADR 0004, Punkt 4).
- Keine Point-in-Time-Wiederherstellung: im schlimmsten Fall gehen die Änderungen seit der letzten Sicherung verloren (höchstens ein Tag). Für größere Betriebe kann später WAL-Archivierung ergänzt werden.
