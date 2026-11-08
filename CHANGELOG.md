# Changelog

Alle wesentlichen Änderungen, vor allem solche, die Betreiber betreffen (neue Variablen, Container, Volumes).

## Unveröffentlicht

### Neu
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
