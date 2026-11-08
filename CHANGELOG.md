# Changelog

Alle wesentlichen Änderungen, vor allem solche, die Betreiber betreffen (neue Variablen, Container, Volumes).

## Unveröffentlicht

### Neu
- Ersteinrichtung im Browser, geschützt durch einen Einrichtungscode aus dem Server-Log (oder `SETUP_TOKEN`).
- Anmeldung mit Sitzungs-Cookie, Schutz vor Durchprobieren, Zwei-Faktor-Anmeldung (TOTP) per API, Passwort ändern, Firmenwechsel.
- API für Kontakte (inkl. Kanäle, Adressen, Verknüpfungen, Archiv) und Projekte (inkl. Status, Baustelle, Mitarbeitende, Archiv).
- Weboberfläche: Ersteinrichtung, Anmeldung, einfache Projekt- und Kontaktlisten.
- Datenbank-Migration `0006_auth_and_lookup`.

### Betrieb
- **Neue Pflichtvariable `APP_SECRET`** (mindestens 32 Zeichen, z. B. `openssl rand -hex 32`). Ohne sie startet der Stack nicht.
- Neue optionale Variablen: `SETUP_TOKEN`, `SESSION_TTL_DAYS`, `SESSION_IDLE_HOURS`, `COOKIE_SECURE`.
- Alle Geheimnisse auch als Datei: `NAME_FILE=/pfad`.
