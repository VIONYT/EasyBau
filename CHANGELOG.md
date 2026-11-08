# Changelog

Alle wesentlichen Änderungen, vor allem solche, die Betreiber betreffen (neue Variablen, Container, Volumes).

## Unveröffentlicht

### Neu
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
