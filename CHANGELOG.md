# Changelog

Alle wesentlichen Änderungen, vor allem solche, die Betreiber betreffen (neue Variablen, Container, Volumes).

## Unveröffentlicht

### Neu
- Stammdaten: Leistungen (Kurz-/Langtext, Einheit, Bestandteile Lohn/Material/Gerät/Fremdleistung/Sonstiges → VK, Soll-Stunden) und Materialien (Artikelnummer, Hersteller, EK, Zuschlag → VK oder VK direkt), Ordner (Standard „Allgemein“), Suche.
- Kataloge aus DATANORM 4/5: Import von Großhändler-Dateien (Zeichensatz DOS/CP850, Latin-1 oder UTF-8 wird erkannt; Artikel, EAN/Matchcode, Langtexte, Preisänderungen; Update-Dateien mit Neu/Ändern/Löschen), Rabatt auf Listenpreise je Katalog und je Rabattgruppe, Suche nach Text, Artikelnummer und EAN mit EK je Einheit, „In Stammdaten übernehmen“.
- Angebotseditor: „+ Aus Stammdaten“ fügt Leistungen, Materialien oder Katalogartikel als Position samt Kalkulation ein.
- Datenbank-Migration `0012_catalogs`.
- Angebotserstellung: Kalkulation je Position mit Kostenzeilen (Lohn als Zeit × Stundensatz, Material, Gerät, Fremdleistung, Sonstiges), Zuschlägen je Kostenart (Vorgabe der Firma oder je Zeile) und Modus Einheits-/Gesamtpreis; der Server rechnet EP, GP, Kosten, Marge und Soll-Stunden. Interne Kalkulation (Kosten, Marge, Soll-Stunden) im Editor, nicht im Dokument. Die Kalkulation wird beim Übernehmen in Folgedokumente mitkopiert.
- Empfänger, Bindefrist („gültig bis“) im Kopf; Fertigstellen vergibt die Nummer (A-…, KV-…, AB-…), friert Firma und Empfänger ein und sperrt das Dokument; danach Status versendet → beauftragt / abgelehnt.
- Schalter „Nachtragsangebot“: ein Angebots-Entwurf wird mit einem Klick zum Nachtrag zum Hauptauftrag (Grund nach VOB/B/BGB, Begründung, Nummerierung N01.1 …) und zurück; fertiggestellte Nachträge erhalten die Nummer des Auftrags mit Zusatz (z. B. AB-00101/N01); beauftragt/abgelehnt wird am Nachtrag mitgeführt.
- Druckansicht als Brief (Absender, Empfänger, Nummer, Positionen, Summen, Fußzeile) zum Drucken oder „Als PDF speichern“ im Browser; Entwürfe mit Wasserzeichen.
- Datenbank-Migration `0011_quote_workflow`.
- Bautagebuch im Projekt: ein Bautagesbericht je Tag mit Wetter (Wetterlage, Temperaturen), Personal und Stunden (vorbelegt mit Projektteam und Arbeitszeiten der Firma), ausgeführten Leistungen, Material, Geräten, besonderen Vorkommnissen und Fotos (direkt mit der Kamera, abgelegt in der Projektablage unter „Fotos“).
- Unterschrift schließt den Bericht ab: Kopfdaten (Auftraggeber, Leistungsort, Firma) werden eingefroren, Bericht und Fotos sind danach unveränderlich (Beweisfunktion, VOB/B § 6). Ergänzungen als neuer Bericht für denselben Tag.
- Berichte laufen über Vorlagen; Regiebericht, Einsatzbericht, Abnahmeprotokoll, Bedenken-/Behinderungsanzeige u. a. sind über die API bereits nutzbar (Oberfläche folgt).
- Datenbank-Migration `0010_site_diary`.

### Behoben
- Speichern mit `If-Match` schlug hinter dem Proxy fehl, wenn die Antwort komprimiert ausgeliefert wurde (Caddy hängt `-zstd`/`-gzip` an das ETag).
- Aufmaß im Projekt: Aufmaßblätter als Angebotsaufmaß oder Leistungsaufmaß, Bereiche und Räume (z. B. Haus A › EG › Bad) mit Maßen L/B/H als Variablen, Zeilen mit Formeln (deutsches Zahlenformat, Vorlagen wie Wandfläche, Rechteck, Abzug Öffnung), Ergebnis live beim Tippen und maßgeblich auf dem Server gerechnet, Abzüge, Zuordnung zu LV-Positionen aus Angebot, Auftrag und Nachträgen.
- Mengen je LV-Position mit Mehr-/Mindermengen und Hinweis ab 10 % Abweichung (VOB/B § 2 Abs. 3); „Mengen übernehmen“ setzt die Mengen in Entwürfen (Kennzeichen „aus Aufmaß“).
- Gemeinsames Aufmaß: Abschluss mit Namen beider Seiten und Zeitstempel; danach ist das Blatt gesperrt.
- Aufmaß, Bautagebuch-Berichte und Dokumente sind fest an ihr Projekt gebunden: Räume, LV-Positionen, Fotos und Korrekturzeilen müssen aus demselben Projekt stammen (Datenbank-Trigger), ein Verschieben in ein anderes Projekt ist ausgeschlossen.
- Datenbank-Migration `0009_measurement_integrity`.
- Aufmaß-Ergebnisse, Mengen und Summen werden kaufmännisch auf die Nachkommastellen der Einheit gerundet (Handwerksregel: m und m² 2 Stellen, z. B. 34,657 m² → 34,66 m²; m³ und t 3 Stellen; Stück, Pauschal und Gebinde ganze Zahlen). Positionsmengen dürfen nicht mehr Stellen haben als ihre Einheit. Eingaben wie Maße dürfen genauer sein (0,885 m).
- Projektanlage in der Oberfläche: Name, Kunde, Baustelle (mit „Adresse des Kunden übernehmen“), Zeitraum, Status, Projektnummer, Beschreibung. Projektseite mit Übersicht, Status direkt änderbar, Bearbeiten, Kartenlink zur Baustelle.
- Dokumente im Projekt: „Neues Dokument“ mit den im Projektstand sinnvollen Arten (Angebot, Kostenvoranschlag, Auftragsbestätigung, Nachtragsangebot nur mit Auftrag, Lieferschein, Rechnung, Teil-, Abschlags- (fortlaufend nummeriert) und Schlussrechnung, Gutschrift), leer oder aus einem bestehenden Dokument (Positionen, Texte, Empfänger und Leistungsort werden übernommen).
- Dokument-Entwürfe bearbeiten: Kopfdaten, Anfangs- und Schlusstext, Leistungsverzeichnis mit Titeln (zwei Ebenen), Positionen, Pauschalen, Bedarfs- und Alternativpositionen, Texten; Ordnungszahlen automatisch; Summen, Rabatt und Umsatzsteuer je Steuersatz rechnet der Server. Festgeschriebene Dokumente bleiben unveränderlich.
- Projektablage: Ordner je Projekt aus einer Firmenvorlage (Pläne, Fotos, Verträge & Angebote, Schriftverkehr, Genehmigungen & Nachweise, Sonstiges), Dateien hochladen (auch direkt mit der Handykamera und per Drag & Drop), Vorschau für Bilder, PDF und Videos, umbenennen, verschieben, löschen. Baustellen-Rollen sehen nur ihre Projekte und dürfen nur eigene Dateien löschen.
- Echte Adressen in der Oberfläche (`/projekte/…`, `/dokumente/…`), die Zurück-Taste des Handys funktioniert.
- Datenbank-Migration `0008_project_filing`.
- Ersteinrichtung im Browser, geschützt durch einen Einrichtungscode aus dem Server-Log (oder `SETUP_TOKEN`).
- Anmeldung mit Sitzungs-Cookie, Schutz vor Durchprobieren, Zwei-Faktor-Anmeldung (TOTP) per API, Passwort ändern, Firmenwechsel.
- API für Kontakte (inkl. Kanäle, Adressen, Verknüpfungen, Archiv) und Projekte (inkl. Status, Baustelle, Mitarbeitende, Archiv).
- Weboberfläche: Ersteinrichtung, Anmeldung, einfache Projekt- und Kontaktlisten.
- Datenbank-Migration `0006_auth_and_lookup`.
- Benutzerverwaltung in der Oberfläche: Mitglieder und Rollen, Personen per Einladungslink einladen (`/einladung#…`, 7 Tage gültig), Einladungen zurückziehen, Mitglieder entfernen, zweiten Faktor einer Person zurücksetzen. Der letzte Admin einer Firma kann nicht entfernt oder herabgestuft werden.
- Sicherheitsschlüssel und Passkeys (WebAuthn/FIDO2, z. B. YubiKey): als zweiter Faktor nach dem Passwort oder für die Anmeldung ganz ohne Passwort (mit PIN bzw. Biometrie). Mehrere Schlüssel je Person, umbenennen, entfernen.
- Seite „Sicherheit“: Authenticator-App (TOTP) mit QR-Code einrichten und abschalten, Schlüssel verwalten, Passwort ändern.
- Anmeldung in zwei Schritten: nach dem Passwort wird der zweite Faktor abgefragt (Schlüssel oder Code).
- Admins müssen einen zweiten Faktor einrichten, bevor sie weiterarbeiten können (serverseitig erzwungen).
- Datenbank-Migration `0007_users_and_webauthn`.
- End-to-End-Test (Playwright, Handy-Ansicht) mit virtuellem Sicherheitsschlüssel: `pnpm test:e2e`.

### Behoben
- Zeitstempel der API werden einheitlich als ISO 8601 in UTC (`…Z`) ausgegeben.

### Betrieb
- **Neue Pflichtvariable `APP_SECRET`** (mindestens 32 Zeichen, z. B. `openssl rand -hex 32`). Ohne sie startet der Stack nicht.
- Neue optionale Variablen: `SETUP_TOKEN`, `SESSION_TTL_DAYS`, `SESSION_IDLE_HOURS`, `COOKIE_SECURE`.
- Alle Geheimnisse auch als Datei: `NAME_FILE=/pfad`.
- Neue Variable `PUBLIC_URL` (Standard: `https://<APP_DOMAIN>`): öffentliche Adresse inkl. Port. Sicherheitsschlüssel sind an diese Domain gebunden, Einladungslinks verwenden sie.
- Neue Variable `REQUIRE_ADMIN_MFA` (Standard `true`): Admins müssen einen zweiten Faktor einrichten.
- **Neues Volume `files`** für die Projektablage (in `app` und `worker` unter `/data/files`). Es muss mitgesichert werden.
- Neue Variable `UPLOAD_MAX_MB` (Standard `50`): größte erlaubte Datei beim Hochladen.
