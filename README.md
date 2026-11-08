# OpenPlancraft

Webbasierte Betriebssoftware für Bau- und Handwerksbetriebe: Kundenmanagement, Projekte, Angebotskalkulation, GoBD-konforme Rechnungen mit E-Rechnung (ZUGFeRD/XRechnung), digitales Bautagebuch und Export für Steuerberater (DATEV) und Finanzamt (GoBD Z3).

**Open Source, selbst gehostet per Docker.** Firmen betreiben das System auf ihrer eigenen Infrastruktur (`docker compose up -d`), ohne Abhängigkeit von Cloud-Diensten.

**Lizenz:** [AGPL-3.0-or-later](LICENSE) · „OpenPlancraft“ ist ein Arbeitstitel und wird vor dem ersten Release umbenannt.

**Status:** Grundgerüst (Services, Docker-Stack, Tests, CI) und Datenbankschema für das MVP. Fachmodule folgen.

## Schnellstart (Self-Hosting)

```bash
cp .env.example .env        # POSTGRES_PASSWORD und APP_SECRET setzen, für einen Server APP_DOMAIN
docker compose up -d --build
docker compose logs app | grep Einrichtungscode
```

Danach ist die Anwendung unter `https://localhost` bzw. Ihrer Domain erreichbar; die Ersteinrichtung fragt nach dem Einrichtungscode. Details: [docs/self-hosting](docs/self-hosting/README.md). Caddy holt das Zertifikat automatisch. Profil *kompakt* (Standard) braucht einen Server mit 2 GB RAM.

## Entwicklung

Voraussetzungen: Node 22, pnpm (über `corepack enable`), Docker.

```bash
pnpm install
docker compose -f compose.yaml -f compose.dev.yaml up -d db
DATABASE_URL=postgres://openplancraft:<passwort>@localhost:5432/openplancraft pnpm dev
```

Tests: `pnpm check` (Lint, Typen, Tests) oder komplett in Docker: `docker compose -f compose.test.yaml run --rm --build test`.

## Dokumentation

- [DESIGN.md](DESIGN.md) – Produkt, Architektur, Datenmodell, Sicherheit, UX
- [CLAUDE.md](CLAUDE.md) – Arbeitsregeln und Konventionen für die Entwicklung
- [docs/RESEARCH.md](docs/RESEARCH.md) – Markt- und Rechtsrecherche
- [docs/adr/0001-open-source-self-hosting.md](docs/adr/0001-open-source-self-hosting.md) – Entscheidung zu Open Source, Docker und Lizenz
- [docs/adr/0003-sql-migrationen.md](docs/adr/0003-sql-migrationen.md) – Datenbankschema als SQL-Migrationen, Rollen, Mandantentrennung
- [docs/adr/0002-schlanker-stack.md](docs/adr/0002-schlanker-stack.md) – Schlanker Stack: PostgreSQL, Typst, Betriebsprofile (ab 2 GB RAM)
