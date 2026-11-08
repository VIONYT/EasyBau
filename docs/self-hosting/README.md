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
- Zwei-Faktor-Anmeldung (TOTP, z. B. mit einer Authenticator-App) ist für Admins vorgesehen. Das System weist nach der Anmeldung darauf hin.
- Nur für lokale Tests ohne HTTPS: `COOKIE_SECURE=false`.

## 4. Updates

```bash
git pull && docker compose up -d --build
```

Datenbank-Migrationen laufen beim Start automatisch (`MIGRATE_ON_START=true`). Eine bereits angewendete Migration wird nie verändert; der Start bricht ab, falls doch.

## 5. Prüfen

```bash
BASE_URL=https://<APP_DOMAIN> sh infra/smoke-test.sh
```

Noch nicht im Stack und in Arbeit: Dateispeicher mit Archivschutz (Object Lock), KoSIT-Prüfer, automatisches Backup.
