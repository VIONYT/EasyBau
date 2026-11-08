# ADR 0001: Open Source und Self-Hosting per Docker

- Status: angenommen. Lizenz: AGPL-3.0-or-later (bestätigt). Projektname: Umbenennung vor dem ersten Release (bestätigt).
- Datum: 2026-11-08

## Kontext
Das System soll Open Source sein. Interessierte Firmen betreiben es auf ihrer eigenen Infrastruktur. Betrieb und Tests laufen über Docker.

## Entscheidung
1. Auslieferung als Docker-Images (amd64/arm64, signiert, mit SBOM) plus `compose.yaml`. Alle Pflichtkomponenten laufen im Stack: PostgreSQL, MinIO (Object Lock), KoSIT-Validator, Caddy und der Backup-Container (Valkey entfallen, siehe ADR 0002).
2. Es gibt keine Pflicht-Abhängigkeit von externen SaaS-Diensten. Optionale Integrationen werden über Umgebungsvariablen geschaltet und sind standardmäßig aus.
3. ~~Valkey statt Redis~~ → ersetzt durch ADR 0002: kein separater Queue-/Cache-Dienst, Warteschlange in PostgreSQL.
4. Alle automatischen Tests sind über `compose.test.yaml` reproduzierbar. Die CI testet zusätzlich den kompletten Stack, Upgrades und Backup/Restore.
5. Die Mandantentrennung bleibt erhalten, Standard ist aber eine Firma pro Installation.

## Lizenz (bestätigt)
**AGPL-3.0-or-later**: Wer das System verändert und anderen als Dienst anbietet, muss seine Änderungen veröffentlichen. Firmen, die es nur intern nutzen, haben keine Pflichten. Das schützt das Projekt davor, dass jemand es ohne Rückfluss als geschlossenes SaaS weiterverkauft.
Alternativen:
- Apache-2.0 / MIT: maximal freizügig, aber geschlossene Weiterverkäufe sind möglich.
- GPL-3.0: Copyleft greift nicht bei reiner Bereitstellung als Webdienst.

## Projektname (Umbenennung vor Release bestätigt)
„OpenPlancraft“ enthält die Marke eines bestehenden Anbieters. Für ein öffentliches Open-Source-Projekt ist das markenrechtlich riskant (Verwechslungsgefahr) und widerspricht der Projektregel, keine fremden Markennamen zu übernehmen. Entscheidung: Bis zum ersten Release bleibt „OpenPlancraft“ ein interner Arbeitstitel. Davor werden Repository, Image-Namen, Paketnamen und Domain umbenannt. Im Code wird der Name deshalb nur an einer zentralen Stelle (Konfiguration/Branding) gepflegt.

## Konsequenzen
- Verantwortung für GoBD-konforme Aufbewahrung, Backups und Sicherheit liegt beim Betreiber. Das System unterstützt ihn mit Betriebs-Check, automatischen Restore-Tests, Object-Lock-Prüfung und einer Vorlage für die Verfahrensdokumentation.
- Neue Laufzeitabhängigkeiten müssen als Container im Stack verfügbar und lizenzkompatibel sein.
