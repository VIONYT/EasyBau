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
| `ARCHIVE_S3_SECRET_KEY` | Passwort des App-Zugangs zum Belegarchiv (RustFS), z. B. `openssl rand -hex 24`. Bei externem S3 der geheime Zugangsschlüssel (siehe Abschnitt 5b). |

Statt Werten in `.env` können Docker-Secrets genutzt werden: `APP_SECRET_FILE=/run/secrets/app_secret`.

**Variante A – vorgebaute Images (empfohlen, auch für kleine Server):** Die Images `app`, `web` und `kosit` liegen für amd64 und arm64 in der GitHub Container Registry; das Belegarchiv (RustFS) kommt als fest gepinntes Image des Herstellers. Es muss nichts gebaut werden.

```bash
# in .env: APP_VERSION=1.2.3 (eine Release-Version) oder für den Entwicklungsstand
#   APP_VERSION=edge und KOSIT_IMAGE_VERSION=edge
docker compose pull
docker compose up -d --no-build
```

**Variante B – selbst bauen** (z. B. für eigene Änderungen):

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

- Passwörter: mindestens 12 Zeichen, gespeichert mit argon2id nach RFC 9106 (64 MiB Speicher, 3 Durchläufe, 4 Lanes, eigenes Salt je Passwort). Ältere Hashes mit schwächeren Werten werden bei der nächsten Anmeldung automatisch erneuert. Es laufen höchstens 4 Berechnungen gleichzeitig (Spitze ca. 256 MiB RAM), damit auch der kompakte Server (2 GB) bei vielen gleichzeitigen Anmeldungen stabil bleibt.
- **Passwort vergessen** (Anmeldeseite): Mit eingerichtetem E-Mail-Versand kommt ein Link an die Adresse der Anmeldung (30 Minuten gültig, nur einmal verwendbar). Die Antwort ist für jede Adresse gleich, sodass niemand erfährt, ob es eine Anmeldung gibt. Ein Admin kann unter „Benutzer › Passwort-Link“ einen Link für eine Person erstellen (nur für Personen, die keiner anderen Firma angehören). **Ist ein SMTP-Server eingerichtet, läuft jeder Passwort-Link nach spätestens 30 Minuten ab** – auch der vom Admin erstellte. Nur ohne E-Mail-Versand, wenn der Link persönlich übergeben werden muss, gilt er 24 Stunden. Ein neues Passwort beendet alle Sitzungen; der zweite Faktor bleibt bestehen.
- **E-Mail-Bestätigung** unter „Sicherheit“ (Link 48 Stunden gültig). Annahme einer Einladung und Zurücksetzen per E-Mail bestätigen die Adresse ebenfalls.
- Einmal-Links enthalten 256 Bit Zufall; in der Datenbank steht nur ihr SHA-256-Hash. Der E-Mail-Text mit dem Link wird nach der Annahme durch den SMTP-Server gelöscht.
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
- Die Vorschau des Rechnungs-PDFs bei Eingangsrechnungen wird im Proxy (Caddy) als einzige Adresse für die Einbettung in die eigene Seite freigegeben (`X-Frame-Options: SAMEORIGIN` nur für `/api/v1/incoming-invoices/<id>/original`). Wer einen eigenen Reverse-Proxy nutzt, muss diese Ausnahme ebenfalls setzen, sonst bleibt die Vorschau leer (Öffnen im neuen Tab geht immer).
- **Dokumente per E-Mail:** Fertiggestellte Angebote, Auftragsbestätigungen, Nachträge und festgeschriebene Rechnungen/Gutschriften lassen sich am Dokument versenden („Per E-Mail senden“). Anhang ist immer das archivierte Original (bei Rechnungen das ZUGFeRD-PDF), auf Wunsch zusätzlich die XRechnung. Betreff und Text kommen aus Einstellungen › E-Mail-Vorlagen (dort auch eine Blindkopie an das Büro-Postfach). Das Dokument wird erst auf „versendet“ gesetzt, wenn der SMTP-Server die E-Mail angenommen hat. Eine Zustellbestätigung des Empfängers gibt es nicht.

### Rechnungseingang per E-Mail (optional)

- Standard: aus. Freischalten mit `INCOMING_MAIL_ENABLED=true` in der `.env` (Abruf alle `INCOMING_MAIL_INTERVAL_MINUTES` Minuten, Standard 5), Stack neu starten.
- Danach trägt jede Firma unter Einstellungen › Rechnungseingang ihr IMAP-Postfach ein (Server, Port 993 mit TLS, Benutzer, Passwort, Ordner; optional ein Ordner für verarbeitete E-Mails). Das Passwort wird verschlüsselt gespeichert (Schlüssel aus `APP_SECRET`) und nie angezeigt.
- Abgerufen werden ungelesene E-Mails. Rechnungsanhänge (PDF/ZUGFeRD, XRechnung-XML, JPG/PNG) landen in „Eingangsrechnungen › Zu prüfen“ (gleiche Prüfung wie beim Hochladen, Original revisionssicher abgelegt); andere Anhänge werden ignoriert. Die E-Mail wird danach als gelesen markiert bzw. verschoben. Bei vorübergehenden Fehlern bleibt sie ungelesen und wird beim nächsten Abruf erneut verarbeitet.
- Der Abruf läuft im Prozess, der die API bedient; mehrere API-Instanzen stimmen sich über eine Datenbank-Sperre ab. Ergebnis des letzten Abrufs und Fehler (z. B. „Anmeldung am Postfach fehlgeschlagen“) stehen in den Einstellungen; „Jetzt abrufen“ testet die Zugangsdaten.
- Der Server muss den IMAP-Server erreichen dürfen (ausgehend Port 993 bzw. 143).
- Bitte ein eigenes Postfach nur für Rechnungen verwenden: jeder PDF-/Bild-Anhang wird als mögliche Rechnung übernommen.

## 5a. E-Rechnung (Dienst „kosit“)

- Jede Rechnung und Gutschrift wird beim Festschreiben als E-Rechnung erzeugt:
  - ZUGFeRD 2.x (Profil EN 16931) eingebettet im PDF/A-3
  - für öffentliche Auftraggeber mit Leitweg-ID bzw. auf Wunsch des Kunden zusätzlich als XRechnung (UBL oder CII)
- Der Container `kosit` (KoSIT-Validator mit XRechnung-Regeln, ADR 0007) prüft jede Datei. Nur geprüfte Rechnungen erhalten eine Nummer. XML und Prüfbericht werden mit SHA-256 archiviert.
- Der Dienst ist nur intern erreichbar (`KOSIT_URL=http://kosit:8080`) und braucht etwa 300 MB RAM. Er startet mit dem Stack, der erste Start dauert etwa 30 Sekunden.
- Läuft `kosit` nicht, lassen sich keine Rechnungen festschreiben. Angebote, Aufträge und alles andere funktionieren weiter. Zustand: Einstellungen › Betrieb.
- Leitweg-ID, E-Mail für E-Rechnungen und gewünschtes Format stehen am Kontakt (Kontakte › Kontakt öffnen › E-Rechnung). Für XRechnung braucht die Firma E-Mail, Telefon und IBAN (Einstellungen › Firma).

## 5b. Revisionssicheres Belegarchiv (Dienst „storage“ oder externer S3)

- **Was archiviert wird:** Originale festgeschriebener Belege, also PDF/A, ZUGFeRD-PDF, XRechnung-XML und KoSIT-Prüfbericht. Sie liegen zuerst im Volume `files`. Der Worker kopiert sie innerhalb von etwa 30 Sekunden in einen S3-Bucket mit **Object Lock (WORM)**, gesperrt bis zum Ende der Aufbewahrungsfrist (10 Jahre ab Ende des Belegjahres). Bis dahin kann niemand sie ändern oder löschen, auch kein Administrator.
- **Standard (mitgelieferter RustFS, [ADR 0009](../adr/0009-belegarchiv-rustfs.md)):**
  - Dienst `storage` mit Volume `archive`, nur intern erreichbar; Version fest vorgegeben (Tag + Digest in `compose.yaml`); neue Versionen kommen mit Projekt-Updates, erst nach bestandenen WORM-Tests.
  - In der `.env` nur `ARCHIVE_S3_SECRET_KEY` setzen (z. B. `openssl rand -hex 24`). Beim Start legt `storage-setup` den Bucket `belegarchiv` mit Object Lock an und einen **eingeschränkten Zugang für die App**: schreiben und lesen ja, löschen oder Bucket ändern nein.
  - Der Root-Schlüssel von RustFS wird beim ersten Start zufällig erzeugt und liegt nur im Volume `archive-keys` (nicht in der `.env`, nicht in der App). Anzeigen bei Bedarf: `docker compose exec storage cat /keys/root-secret`.
- **Externer S3** (empfohlen, wenn das Archiv unabhängig vom Server sein soll):
  1. Beim Anbieter einen Bucket **mit aktiviertem Object Lock** anlegen. Das geht nur beim Anlegen. Dazu einen Zugang mit Schreib- und Leserecht auf diesen Bucket.
  2. In der `.env` eintragen:
     - `COMPOSE_FILE=compose.yaml:compose.external-s3.yaml`
     - `ARCHIVE_S3_ENDPOINT`, `ARCHIVE_S3_REGION`, `ARCHIVE_S3_BUCKET`
     - `ARCHIVE_S3_ACCESS_KEY`, `ARCHIVE_S3_SECRET_KEY`
     - `ARCHIVE_S3_CREATE_BUCKET=false`
     - bei Bedarf `ARCHIVE_S3_PATH_STYLE=false`
  3. `docker compose up -d`. Der mitgelieferte RustFS läuft dann nicht.
- **Zustand prüfen:** Einstellungen › Betrieb zeigt, ob der Bucket erreichbar ist und Object Lock hat, und wie viele Originale noch ausstehen oder fehlgeschlagen sind. Am Dokument steht „Original revisionssicher archiviert (unveränderbar bis …)“.
- **Was der mitgelieferte RustFS schützt:** Er schützt gegen Änderungen über die Anwendung (auch wenn App oder Datenbank übernommen werden: der App-Zugang kann nichts löschen) und gegen versehentliches Löschen. Er schützt nicht gegen den Ausfall der Festplatte. Dafür gibt es die tägliche Sicherung (sie enthält alle Arbeitskopien) und optional einen externen S3.
- **Archiv-Abgleich:** Der Worker prüft jede Nacht (03:47 Uhr) die 500 am längsten nicht geprüften Originale im Bucket: vorhanden, SHA-256, Größe und Sperrfrist (jedes zehnte zusätzlich durch Herunterladen und Nachrechnen). Fehlt ein Original oder ist es beschädigt, wird es aus der Arbeitskopie neu geschrieben, mit der ursprünglichen Sperrfrist (als neue Version; die alte bleibt gesperrt). Gibt es keine unveränderte Kopie mehr, meldet der Betriebs-Check das Original als **fehlend** (rot). Einen vollständigen Abgleich startet „Belegarchiv jetzt vollständig abgleichen“ im Betriebs-Check bzw. für alle Firmen `sh infra/archive-reconcile.sh`; nach einer Wiederherstellung (`infra/restore.sh`) läuft er automatisch.
- **Belegarchiv umziehen (z. B. mitgelieferter RustFS → externer S3):**
  1. Beim Anbieter einen Bucket **mit Object Lock** anlegen (siehe oben) und den Zugang bereithalten.
  2. In der `.env` das bisherige Archiv als Quelle eintragen; der RustFS-Dienst läuft dabei weiter (noch **kein** `COMPOSE_FILE` mit `compose.external-s3.yaml`):
     - `ARCHIVE_PREVIOUS_S3_ENDPOINT=http://storage:9000`
     - `ARCHIVE_PREVIOUS_S3_ACCESS_KEY=archiv` (der bisherige `ARCHIVE_S3_ACCESS_KEY`; er darf lesen)
     - `ARCHIVE_PREVIOUS_S3_SECRET_KEY=<bisheriger ARCHIVE_S3_SECRET_KEY>`
     - `ARCHIVE_PREVIOUS_S3_BUCKET=belegarchiv`
  3. Den neuen Bucket als `ARCHIVE_S3_ENDPOINT`, `ARCHIVE_S3_REGION`, `ARCHIVE_S3_BUCKET`, `ARCHIVE_S3_ACCESS_KEY`, `ARCHIVE_S3_SECRET_KEY` eintragen, dazu `ARCHIVE_S3_CREATE_BUCKET=false`. Dann `docker compose up -d`. Neue Originale gehen ab jetzt in den neuen Bucket.
  4. `sh infra/archive-reconcile.sh` starten. Der Worker schreibt jedes archivierte Original mit seiner ursprünglichen Sperrfrist in den neuen Bucket, aus der Arbeitskopie oder, falls diese fehlt, aus dem bisherigen Archiv (nur wenn die SHA-256 stimmt). Den Fortschritt zeigt der Betriebs-Check jeder Firma.
  5. Wenn der Abgleich fertig ist und **kein Original als fehlend** gemeldet wird: `ARCHIVE_PREVIOUS_S3_*` entfernen, `COMPOSE_FILE=compose.yaml:compose.external-s3.yaml` setzen und `docker compose up -d`. Das Volume `archive` aufheben (am besten bis zum Ende der letzten Frist).
  Andersherum (externer S3 → anderer Anbieter) geht es genauso: den bisherigen Bucket als `ARCHIVE_PREVIOUS_S3_*` eintragen.
- **Exporte:** Der GoBD-Export (Z3) enthält die Originale im Ordner `belege/` mit Prüfsummen. Der DATEV-Export liefert auf Wunsch ein ZIP mit PDF je Rechnung.

## 5c. App und Offline-Betrieb auf der Baustelle ([ADR 0010](../adr/0010-offline-baustelle.md))

- Die Weboberfläche lässt sich auf Handy und Tablet „zum Startbildschirm hinzufügen“ (installierbare App). Voraussetzung ist HTTPS mit gültigem Zertifikat (Caddy erledigt das bei öffentlicher Domain automatisch).
- Aufmaßzeilen, Bautagesberichte und Fotos können ohne Netz erfasst werden; sie werden übertragen, sobald wieder Verbindung besteht (oben im Bildschirm „… Änderung(en) warten auf Übertragung“). Vorher am Projekt „Offline verfügbar machen“ wählen.
- Wer einen eigenen Reverse Proxy statt des mitgelieferten Caddy nutzt: `/sw.js`, `/index.html`, `/registerSW.js` und `/manifest.webmanifest` mit `Cache-Control: no-cache` ausliefern, sonst kommen App-Updates verspätet an.

## 6. Sicherung und Wiederherstellung

Der Dienst `backup` ([ADR 0005](../adr/0005-backup-dienst.md)) sichert **täglich um `BACKUP_TIME`** (Standard 02:30, Zeitzone `TZ`) die Datenbank und die Ablage. Jede Sicherung ist ein Verzeichnis `JJJJ-MM-TT_HHMMSS` mit `db.dump`, `files.tar.gz` und `SHA256SUMS` und wird direkt nach dem Schreiben geprüft. Sicherungen älter als `BACKUP_KEEP_DAYS` (Standard 14) werden gelöscht, aber nur nach einer erfolgreichen neuen Sicherung.

Den Zustand zeigt **Einstellungen › Betrieb › Betriebs-Check** (Warnung, wenn die letzte erfolgreiche Sicherung älter als 26 Stunden ist).

Ebenfalls im Betriebs-Check: die **nächtliche Prüfung des Änderungsprotokolls** (Hash-Kette, GoBD). Der Worker prüft jede Nacht um 02:17 Uhr alle Firmen. Meldet die Prüfung einen Fehler, wurden Einträge außerhalb der Anwendung verändert oder gelöscht (z. B. direkt in der Datenbank): Zugänge zur Datenbank prüfen und mit der letzten Sicherung abgleichen. Fehlt die Prüfung länger als 26 Stunden, läuft der Worker nicht.

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

Auf einem neuen Server zuerst Repository und `.env` einrichten und die Sicherungsverzeichnisse nach `BACKUP_DIR` (bzw. in das Volume `backups`) kopieren. Nach dem Wiederherstellen gleicht der Worker das Belegarchiv vollständig ab: Liegt auf dem neuen Server ein leeres Archiv, werden alle Originale aus der wiederhergestellten Ablage mit ihrer ursprünglichen Sperrfrist neu archiviert. Alles, was nach der Sicherung eingegeben wurde, ist danach verloren. Wiederherstellen regelmäßig üben, z. B. auf einem Testrechner.

## 7. Exporte

Unter Einstellungen › Betrieb (Rolle mit Recht „Exporte“, standardmäßig Inhaber und Büro):

- **DATEV-Buchungsstapel**: CSV-Datei im DATEV-Format (EXTF) für einen Zeitraum, mit den festgeschriebenen Rechnungen und Gutschriften (je Steuersatz eine Buchung) und den Zahlungseingängen. Vorher unter Einstellungen › DATEV Berater- und Mandantennummer, Kontenrahmen und ggf. abweichende Erlöskonten eintragen. Den ersten Import bitte mit dem Steuerberater abstimmen. Geprüfte Eingangsrechnungen erscheinen mit einer Buchung je Kostenzuweisung (Aufwandskonto je Kostenart mit BU-Schlüssel für die Vorsteuer, § 13b auf dem Automatikkonto, Sammelkreditor) und ihren Zahlungen; Aufwands- und Kreditorenkonto lassen sich unter Einstellungen › DATEV anpassen.
- **GoBD-Export (Z3)**: ZIP mit `index.xml` und CSV-Tabellen nach dem Beschreibungsstandard für die Datenträgerüberlassung an die Betriebsprüfung. Die Datei `gdpdu-01-09-2004.dtd` wird von der Prüfsoftware mitgebracht.
- **Vollständiger Datenexport**: alle Daten der Firma als JSON und alle Dateien der Projektablage in einem ZIP, z. B. für einen Umzug oder als zusätzliche Sicherung. Zugangsdaten (Passwörter, Schlüssel) und die verschlüsselte IBAN sind nicht enthalten. Der Export ist keine Wiederherstellung – dafür gibt es die Sicherung.

Jeder Export wird im Audit-Log vermerkt.

## 8. Updates

```bash
# vorgebaute Images (APP_VERSION in .env auf die neue Version bzw. edge):
git pull && docker compose pull && docker compose up -d --no-build
# oder selbst bauen:
git pull && docker compose up -d --build
```

Datenbank-Migrationen laufen beim Start automatisch (`MIGRATE_ON_START=true`). Eine bereits angewendete Migration wird nie verändert; der Start bricht ab, falls doch.

## 9. Prüfen

```bash
BASE_URL=https://<APP_DOMAIN> sh infra/smoke-test.sh
```

Alle Dienste der Planung sind jetzt im Stack: proxy, app, db, kosit, storage (mit den Einmal-Diensten storage-keys und storage-setup), backup (im Profil „standard“ zusätzlich worker).
