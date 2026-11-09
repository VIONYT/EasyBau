# Betrieb auf eigener Infrastruktur

Diese Anleitung richtet sich an Betreiber, die das System selbst betreiben (ADR 0001). Voraussetzung: ein Linux-Server mit Docker ≥ 24 (amd64 oder arm64). Im Profil *kompakt* reichen 2 GB RAM.

## 1. Installation

```bash
git clone <repository> erp && cd erp
cp .env.example .env
```

In `.env` mindestens setzen:

| Variable | Bedeutung |
|---|---|
| `APP_DOMAIN` | Ihre Domain, z. B. `erp.meine-firma.de`. Der DNS-Eintrag muss auf den Server zeigen; Caddy holt das Zertifikat automatisch. |
| `POSTGRES_PASSWORD` | Datenbankpasswort, z. B. `openssl rand -hex 24`. |
| `APP_SECRET` | Hauptschlüssel für verschlüsselte Felder (2FA-Geheimnisse, IBAN), z. B. `openssl rand -hex 32`. **Sicher aufbewahren** (z. B. im Passwortmanager). Ohne ihn sind diese Felder nach einer Wiederherstellung nicht mehr lesbar. |

Statt Werten in `.env` können Docker-Secrets genutzt werden: `APP_SECRET_FILE=/run/secrets/app_secret`.

```bash
docker compose up -d --build
```

## 2. Ersteinrichtung

Beim ersten Start ist das System noch ohne Firma. Damit niemand anderes eine frisch gestartete Instanz übernehmen kann, ist die Einrichtung durch einen **Einrichtungscode** geschützt:

```bash
docker compose logs app | grep Einrichtungscode
```

Danach `https://<APP_DOMAIN>` öffnen, den Code eingeben, die Firma und das erste Admin-Konto anlegen. Alternativ lässt sich der Code fest vorgeben (`SETUP_TOKEN` in `.env`). Nach Abschluss ist die Einrichtung gesperrt.

## 3. Anmeldung und Sicherheit

- Passwörter: mindestens 12 Zeichen, gespeichert mit argon2id.
- Sitzungen: Cookie `__Host-sid` (HttpOnly, Secure, SameSite=Lax), 30 Tage gültig, Abmeldung nach 7 Tagen Inaktivität (`SESSION_TTL_DAYS`, `SESSION_IDLE_HOURS`).
- Schutz vor Durchprobieren: höchstens 10 Anmeldeversuche je E-Mail-Adresse und 50 je IP-Adresse in 15 Minuten.
- Zwei-Faktor-Anmeldung: Authenticator-App (TOTP) oder Sicherheitsschlüssel/Passkey (WebAuthn/FIDO2, z. B. YubiKey). Einrichtung unter „Sicherheit“. Mit einem Schlüssel ist auch die Anmeldung ohne Passwort möglich (PIN oder Biometrie am Schlüssel).
- Admins müssen einen zweiten Faktor einrichten, bevor sie weiterarbeiten können (`REQUIRE_ADMIN_MFA=true`, Standard). Abschalten nur in begründeten Ausnahmen.
- **`PUBLIC_URL` muss exakt der Adresse entsprechen, unter der die Software im Browser aufgerufen wird** (inkl. Port, z. B. `https://bau.example.de` oder `https://localhost:8443`). Standard ist `https://<APP_DOMAIN>`. Sicherheitsschlüssel werden an diese Domain gebunden: Wechselt die Domain, müssen alle Schlüssel neu registriert werden. Einladungslinks werden ebenfalls mit dieser Adresse erzeugt.
- Benutzerverwaltung (Admins): Personen werden per Einladungslink eingeladen. Der Link wird nicht per E-Mail verschickt, sondern in der Oberfläche angezeigt und muss selbst weitergegeben werden; er ist 7 Tage gültig und nur einmal verwendbar.
- Hat eine Person ihren Schlüssel und ihr Handy verloren, kann ein Admin unter „Benutzer“ den zweiten Faktor zurücksetzen. Der letzte Admin einer Firma kann nicht entfernt werden.
- Nur für lokale Tests ohne HTTPS: `COOKIE_SECURE=false`.

## 4. Dateien (Projektablage)

- Hochgeladene Dateien liegen im Docker-Volume `files` (im Container `/data/files`), die Datenbank kennt Name, Größe und Prüfsumme (SHA-256). Siehe [ADR 0004](../adr/0004-dateiablage.md).
- **Das Volume `files` gehört zur Sicherung**, zusammen mit der Datenbank. Der Dienst `backup` sichert beides gemeinsam (Abschnitt 6).
- Größte erlaubte Datei: `UPLOAD_MAX_MB` (Standard 50). Erlaubt sind PDF, Bilder (JPG, PNG, GIF, WebP, HEIC), Videos (MP4, MOV), Office-Dateien, ZIP, Pläne (DWG, DXF), Text/CSV/XML und GAEB (X31, X81–X86). Der Inhalt muss zur Dateiendung passen.
- Für jede neue Firma wird eine Ordnerstruktur angelegt; jedes neue Projekt bekommt diese Ordner.

## 5. E-Mail (optional)

- Ohne SMTP verschickt das System keine E-Mails; Einladungslinks werden in der Oberfläche angezeigt und von Hand weitergegeben.
- Aktivieren: `SMTP_HOST`, `SMTP_FROM` und meist `SMTP_USER`/`SMTP_PASSWORD` (oder `SMTP_PASSWORD_FILE`) in der `.env` setzen, Stack neu starten. Port 587 nutzt STARTTLS (Pflicht), Port 465 mit `SMTP_SECURE=true`.
- E-Mails gehen zuerst in einen Postausgang in der Datenbank und werden vom Worker versendet (bis zu 5 Versuche mit wachsender Pause). Status und Fehler: Einstellungen › Betrieb. Inhalte (z. B. Einladungslinks) werden nach dem Versand gelöscht.
- Antworten gehen an die E-Mail-Adresse der Firma (Einstellungen › Firma).

## 6. Sicherung und Wiederherstellung

Der Dienst `backup` ([ADR 0005](../adr/0005-backup-dienst.md)) sichert **täglich um `BACKUP_TIME`** (Standard 02:30, Zeitzone `TZ`) die Datenbank und die Ablage. Jede Sicherung ist ein Verzeichnis `JJJJ-MM-TT_HHMMSS` mit `db.dump`, `files.tar.gz` und `SHA256SUMS` und wird direkt nach dem Schreiben geprüft. Sicherungen älter als `BACKUP_KEEP_DAYS` (Standard 14) werden gelöscht, aber nur nach einer erfolgreichen neuen Sicherung.

Den Zustand zeigt **Einstellungen › Betrieb › Betriebs-Check** (Warnung, wenn die letzte erfolgreiche Sicherung älter als 26 Stunden ist).

```bash
docker compose exec backup backup.sh run              # sofort sichern
docker compose exec backup backup.sh list             # Sicherungen anzeigen
docker compose exec backup backup.sh verify <Name>    # Sicherung prüfen
docker compose logs backup                            # Protokoll
```

**Ziel:** Standard ist das Docker-Volume `backups` auf demselben Server. Das schützt vor Bedienfehlern, nicht vor einem Plattendefekt oder Einbruch. Deshalb:

- `BACKUP_DIR` auf einen anderen Datenträger oder ein NAS legen (z. B. `BACKUP_DIR=/mnt/nas/openplancraft`), **und/oder**
- die Sicherungen regelmäßig außer Haus kopieren, am besten verschlüsselt (z. B. mit restic oder borg auf ein zweites Gerät oder einen Speicherdienst in der EU). Das Volume liegt unter `docker volume inspect openplancraft_backups`.
- Die **`.env` getrennt sichern** (Passwortmanager oder Tresor). Ohne denselben `APP_SECRET` sind Zwei-Faktor-Geheimnisse und IBAN nach einer Wiederherstellung nicht lesbar.
- Die Sicherungen sind nicht verschlüsselt: Zugriff auf das Sicherungsziel wie auf den Server selbst beschränken.

**Wiederherstellen** (z. B. nach einem Fehler oder auf einem neuen Server mit derselben `.env`):

```bash
sh infra/restore.sh                # vorhandene Sicherungen anzeigen
sh infra/restore.sh <Name>         # Sicherung prüfen, Rückfrage, Datenbank + Ablage ersetzen, Stack starten
```

Auf einem neuen Server zuerst Repository und `.env` einrichten und die Sicherungsverzeichnisse nach `BACKUP_DIR` (bzw. in das Volume `backups`) kopieren. Alles, was nach der Sicherung eingegeben wurde, ist danach verloren. Wiederherstellen regelmäßig üben, z. B. auf einem Testrechner.

## 7. Exporte

Unter Einstellungen › Betrieb (Rolle mit Recht „Exporte“, standardmäßig Inhaber und Büro):

- **DATEV-Buchungsstapel**: CSV-Datei im DATEV-Format (EXTF) für einen Zeitraum, mit den festgeschriebenen Rechnungen und Gutschriften (je Steuersatz eine Buchung) und den Zahlungseingängen. Vorher unter Einstellungen › DATEV Berater- und Mandantennummer, Kontenrahmen und ggf. abweichende Erlöskonten eintragen. Den ersten Import bitte mit dem Steuerberater abstimmen.
- **GoBD-Export (Z3)**: ZIP mit `index.xml` und CSV-Tabellen nach dem Beschreibungsstandard für die Datenträgerüberlassung an die Betriebsprüfung. Die Datei `gdpdu-01-09-2004.dtd` wird von der Prüfsoftware mitgebracht.
- **Vollständiger Datenexport**: alle Daten der Firma als JSON und alle Dateien der Projektablage in einem ZIP, z. B. für einen Umzug oder als zusätzliche Sicherung. Zugangsdaten (Passwörter, Schlüssel) und die verschlüsselte IBAN sind nicht enthalten. Der Export ist keine Wiederherstellung – dafür gibt es die Sicherung.

Jeder Export wird im Audit-Log vermerkt.

## 8. Updates

```bash
git pull && docker compose up -d --build
```

Datenbank-Migrationen laufen beim Start automatisch (`MIGRATE_ON_START=true`). Eine bereits angewendete Migration wird nie verändert; der Start bricht ab, falls doch.

## 9. Prüfen

```bash
BASE_URL=https://<APP_DOMAIN> sh infra/smoke-test.sh
```

Noch nicht im Stack und in Arbeit: Archivspeicher mit Object Lock für festgeschriebene Belege, KoSIT-Prüfer.
