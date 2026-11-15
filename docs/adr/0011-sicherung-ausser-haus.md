# ADR 0011: Verschlüsselte Sicherung außer Haus mit restic

- Status: angenommen
- Datum: 2026-11-15
- Ergänzt: ADR 0005 (Backup-Dienst)

## Kontext
Der Backup-Dienst (ADR 0005) legt jede Nacht eine geprüfte Sicherung von Datenbank und Ablage an – standardmäßig auf demselben Server. Gegen Plattendefekt, Brand, Diebstahl oder einen verschlüsselnden Angreifer hilft nur eine Kopie an einem zweiten Ort. Viele Betriebe haben dafür keine IT-Abteilung; die Kopie muss deshalb automatisch laufen, verschlüsselt sein (Rechnungen, Personaldaten, Kontoverbindungen) und im Betriebs-Check sichtbar werden, wenn sie fehlt oder scheitert.

Geprüfte Alternativen:
- **Kopie per `rclone`/`rsync`** der fertigen Sicherungsverzeichnisse: einfach, aber ohne eigene Verschlüsselung (rclone crypt wäre ein weiteres Konzept) und ohne Deduplizierung – jede Nacht würde die ganze Ablage übertragen.
- **borg**: ausgereift, aber nur über SSH zu einem borg-Server; keine S3-Ziele.
- **Eigener Container nur für die Kopie**: mehr Speicher und ein weiterer Dienst für eine Aufgabe, die direkt nach der Sicherung im selben Ablauf passiert.
- **restic** (BSD-2-Clause): verschlüsselt auf dem Server (AES-256, Schlüssel aus einem Passwort), dedupliziert, schreibt nach S3, Backblaze B2, SFTP und an einen restic-REST-Server, prüft Repositories selbst (`restic check`). Ein Binary, im Alpine-Paket enthalten.

## Entscheidung
1. Der Dienst `backup` bekommt ein **eigenes Image** (`docker/backup.Dockerfile`): `postgres:17-alpine` plus `restic` und SSH-Client. Es ist kein neuer Container; das Image wird wie app/web/kosit in ghcr.io veröffentlicht (`…-backup`) und von Dependabot aktuell gehalten. `pg_dump` passt weiterhin zur Datenbankversion.
2. **Optional und standardmäßig aus:** Erst mit `RESTIC_REPOSITORY` (und `RESTIC_PASSWORD`) in der `.env` kopiert `backup.sh` nach jeder erfolgreichen lokalen Sicherung das Sicherungsverzeichnis mit `restic backup` (Host `easybau`, Tag = Name der Sicherung) an das Ziel und dünnt danach aus (`restic forget --prune`, Standard 14 tägliche, 8 wöchentliche, 24 monatliche Stände). Ein leeres Ziel wird beim ersten Lauf angelegt (`restic init`).
3. Scheitert die Kopie, bleibt die lokale Sicherung gültig; das Ergebnis steht in `backup_run` (`offsite_status` ok/failed/off, Ziel **ohne Zugangsdaten**, Fehlermeldung; Migration 0037). Der Betriebs-Check warnt, wenn keine Kopie außer Haus eingerichtet ist oder die letzte gescheitert ist.
4. Geheimnisse auch als `*_FILE` (Verzeichnis `OFFSITE_SECRETS_DIR`, im Container `/run/offsite`, nur lesbar). SFTP nur mit vorher hinterlegtem `known_hosts` (kein blindes Akzeptieren des Host-Schlüssels).
5. Zurückholen: `backup.sh offsite-list`, `backup.sh offsite-fetch NAME` (holt und prüft die Sicherung nach `/backups`), danach wie gewohnt `infra/restore.sh NAME`. `backup.sh offsite-check` prüft das Repository und stichprobenartig 5 % der Daten.
6. Die CI prüft den ganzen Weg mit einem lokalen restic-Repository: sichern, Kopie vermerken, lokale Sicherung löschen, zurückholen, prüfen.

## Konsequenzen
- **Ohne das restic-Passwort sind die Kopien wertlos.** Es gehört wie `APP_SECRET` getrennt vom Server aufbewahrt (Passwort-Manager, Ausdruck im Tresor). Die Dokumentation sagt das an mehreren Stellen.
- Das Ziel sieht nur verschlüsselte Daten; die Wahl des Anbieters (Standort EU, AV-Vertrag) bleibt beim Betreiber.
- Deduplizierung: Nach der ersten Kopie werden nachts nur Änderungen übertragen; die Ablage (Fotos, PDFs) wird nicht jedes Mal neu hochgeladen.
- Ausgehender Netzzugang des `backup`-Containers zum Ziel ist nötig, wenn die Kopie eingerichtet ist.
- Ein Angreifer mit Zugriff auf den Server kennt auch die Zugangsdaten des Ziels und könnte dort löschen. Wer das ausschließen will, nutzt ein Ziel mit eigener Löschsperre (z. B. S3 mit Object Lock bzw. Versionierung, restic REST-Server mit `--append-only`); das ist in der Dokumentation beschrieben, aber nicht erzwungen.
