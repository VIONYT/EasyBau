# CLAUDE.md – Arbeitsanweisungen für OpenPlancraft

OpenPlancraft ist eine **Open-Source**-Betriebssoftware (ERP) für Bau- und Handwerksbetriebe, die Firmen **selbst per Docker** auf eigener Infrastruktur betreiben: Kunden, Projekte, Angebotskalkulation, Rechnungen (GoBD, E-Rechnung), Bautagebuch, Steuerberater- und Finanzamtsexport.

**Lies vor jeder größeren Änderung [`DESIGN.md`](DESIGN.md)** (Architektur, Datenmodell, UX). Hintergrund: [`docs/RESEARCH.md`](docs/RESEARCH.md). Dieses Projekt ist ein eigenständiges Produkt: übernimm keine Texte, Logos, Markennamen oder Screens von Plancraft oder anderen Anbietern.

## Projektstatus
Grundgerüst steht, Datenbankschema für das MVP ist angelegt (Migrationen 0001–0012). Rechenlogik (`packages/domain`), Ersteinrichtung, Anmeldung (Sitzung, TOTP, WebAuthn/Sicherheitsschlüssel als zweiter Faktor und Passkey, Rate-Limit, erzwungene Admin-2FA), Benutzerverwaltung mit Einladungen, API für Kontakte und Projekte, Projektanlage, Projektablage (Ordner, Upload, ADR 0004) Dokumente mit Leistungsverzeichnis, Kalkulation je Position, Fertigstellen (Angebot/KV/AB/Nachtrag, ohne Rechnungen), Nachtrag-Schalter und Druckansicht (PDF/A über Typst folgt) Aufmaß (Blätter, Räume, Formelzeilen, Mengenübernahme, gemeinsames Aufmaß) Bautagebuch (Berichte aus Vorlagen, Fotos, Unterschrift) und Stammdaten mit DATANORM-Katalogen sowie die Weboberfläche dazu sind fertig. Monorepo, Services (`server` = API + Worker per `APP_ROLE`), Web-Platzhalter, Docker-Stack (proxy, app, db, Volume `files`; Profil `standard` mit separatem `worker`), Test-Stack und CI. Noch nicht im Stack: Archiv-Objektspeicher (S3/Object Lock), kosit, backup. Fachmodule folgen in der Reihenfolge der MVP-Module in DESIGN.md §2.

## Stack (Kurzfassung)
TypeScript strict · pnpm + Turborepo · Fastify · Zod · PostgreSQL 17 (SQL-Migrationen, ADR 0003) · pg-boss (Queue in PostgreSQL) · Typst (PDF/A-3) · S3 via MinIO (Object Lock) · Caddy · Docker Compose · React 19 + Vite + TanStack Router/Query · Tailwind 4 + Radix/shadcn · vite-plugin-pwa + Dexie · Vitest, Testcontainers, Playwright.

## Struktur
```
apps/server   Composition Root: startet API und/oder Worker je nach APP_ROLE (all|api|worker)
apps/api      Fastify-App (buildApi), ohne eigenen Prozessstart → mit inject() testbar.
              routes/ (auth, auth-common, webauthn, users, contacts, projects, documents, files, measurements, reports, catalog), security/ (crypto, passwords, sessions),
              testing/ (Test-Harness, Software-Authenticator für WebAuthn), context.ts
              (requireAuth, requirePermission, inTenant), http.ts (HttpError, parse, Cursor, ETag), idempotency.ts
apps/worker   pg-boss-Jobs (startWorker)
apps/web      React/Vite-PWA (screens/, router.ts, webauthn.ts, i18n.ts)
e2e/          Playwright-Tests gegen einen laufenden Stack (virtueller FIDO2-Schlüssel per CDP)
packages/config  Env-Schema (zod) – einzige Stelle für Konfiguration
packages/db      SQL-Migrationen (migrations/), Runner, createSql (runtime/admin), withTenant(), Readiness
packages/domain  Reine Rechenlogik: Aufmaß-Formeln, Aufmaßzeilen/Mengen, Kalkulation (Position, Dokument, Zielpreis, Gebinde), Einheiten, DATANORM-Leser (catalog/datanorm.ts)
packages/schemas Zod-Schemas und DTO-Typen der API (Server + Web); `@opc/schemas/constants` ohne zod für Werte im Web
packages/storage Dateiablage: ObjectStore (Dateisystem), Upload-Typprüfung, Dateinamen (ADR 0004)
geplant: packages/einvoice  packages/exports  packages/pdf-templates  packages/ui
docker/ (Dockerfiles)  infra/ (Caddyfile, smoke-test.sh)  docs/
```
- Pakete exportieren über die Condition `source` direkt TypeScript (Entwicklung, Tests); gebaut wird nach `dist/`. Imports innerhalb eines Pakets mit `.js`-Endung (NodeNext).
- `packages/domain` enthält **reine** Logik (Kalkulation, Steuern, Summen) ohne I/O. Dort gilt 100 % Testabdeckung.
- `packages/schemas` ist die einzige Quelle für API-Verträge. Frontend und Backend importieren von dort.

## Befehle
```bash
pnpm install
docker compose -f compose.yaml -f compose.dev.yaml up -d db   # nur DB in Docker (Port 5432 lokal)
DATABASE_URL=postgres://openplancraft:<pw>@localhost:5432/openplancraft pnpm dev   # API+Worker :3000, Web :5173
pnpm lint           # Biome (Lint + Format-Prüfung); pnpm format schreibt Formatierung
pnpm typecheck
pnpm test           # Vitest; *.integration.test.ts laufen nur, wenn DATABASE_URL gesetzt ist
pnpm test:coverage  # wie test, erzwingt 100 % Abdeckung für packages/domain (CI)
pnpm build
docker compose -f compose.test.yaml run --rm --build test     # komplette Testpipeline in Docker (wie CI)
docker compose up -d --build && BASE_URL=https://localhost sh infra/smoke-test.sh   # Stack + Smoke-Test
pnpm db:migrate     # Migrationen anwenden (läuft sonst automatisch beim API-Start)
```
```bash
# E2E gegen laufenden Stack (frischer Stack mit SETUP_TOKEN; PUBLIC_URL muss zur BASE_URL passen)
BASE_URL=https://localhost:8443 SETUP_TOKEN=<token> pnpm test:e2e
```
Vor jedem Commit: `pnpm lint && pnpm typecheck && pnpm test`. Vor einem Pull Request: die Docker-Testpipeline.

## Datenbank (ADR 0003)
- Schema nur über neue Dateien `packages/db/migrations/NNNN_name.sql`. **Angewendete Migrationen nie ändern** (Prüfsumme bricht den Start ab).
- Neue Fachtabelle: `tenant_id uuid not null references tenant(id)` + `select enable_tenant_rls('tabelle')`; steuerrelevant zusätzlich `add_audit_trigger`, mit `updated_at` → `add_updated_at_trigger`, Kind eines Belegs → `document_id` + `add_document_child_guard`.
- Anwendungscode greift nur über `createSql(config)` (Rolle `opc_app`) und `withTenant(sql, { tenantId, userId }, tx => …)` zu. Der Admin-Modus ist nur für Migrationen und pg-boss.
- Nummern nur über `next_number(kind)` in der Festschreibe-Transaktion.
- Projektgebundene Daten (Dokumente, Aufmaß, Berichte/Bautagebuch, Dateien) haben immer `project_id NOT NULL`; Verweise untereinander nur innerhalb desselben Projekts (Trigger wie in 0009), `project_id` ist unveränderlich.
- Dateien nur über `services.storage` (`ObjectStore`); Uploads gestreamt, Typ per Endung + Inhalt geprüft (`detectFileType`). Projekt-Sichtbarkeit immer über `requireVisibleProject`/`projectVisibility` aus `context.ts`.
- Integrationstests: `*.integration.test.ts` mit Helfern aus `packages/db/src/test-support.ts`. Erwartete DB-Fehler innerhalb einer Transaktion immer in `tx.savepoint(...)` kapseln.

## API-Konventionen (umgesetzt)
- Jede Route: Eingaben mit `parse(schema, …)` aus `@opc/schemas`, Rechte mit `requirePermission(request, '…')`, Datenzugriff nur in `inTenant(services, auth, tx => …)`.
- Fehler: `throw new HttpError(status, 'deutscher Text', { feld: 'Meldung' })` → RFC 9457.
- Listen: Keyset-Cursor (`encodeCursor`/`decodeCursor`), `limit` ≤ 100. Einzelressourcen liefern `ETag`; `PATCH` prüft `If-Match`.
- POST mit `Idempotency-Key` wird automatisch dedupliziert (`idempotency.ts`).
- Mutierende Anfragen von fremden Origins werden abgewiesen (CSRF); Sitzung nur im HttpOnly-Cookie.
- API-Integrationstests (`apps/api/src/*.integration.test.ts`) legen je Lauf eine eigene Datenbank an.

## Open Source & Self-Hosting
- **Ressourcen sparsam**: Ziel ist das Profil *kompakt* (ca. 1 GB RAM, Server mit 2 GB). Keine neuen Container ohne ADR. Was PostgreSQL kann (Queue, Sessions, Rate-Limit, Volltextsuche), läuft in PostgreSQL – kein Redis/Valkey, kein Elasticsearch, kein Chromium. PDFs nur mit Typst. Der Code muss in beiden Profilen funktionieren (API und Worker im selben Prozess oder getrennt).
- Hintergrundjobs werden mit pg-boss **in derselben Transaktion** wie die auslösende Änderung angelegt. Jobs müssen idempotent sein.
- Alles muss **im eigenen `docker compose`-Stack** lauffähig sein. Keine Pflicht-Abhängigkeit von externen SaaS-Diensten. Externe Dienste sind optional, über `.env` schaltbar und standardmäßig aus.
- Jede neue Einstellung wird in `.env.example` dokumentiert und hat einen sicheren Standardwert. Geheimnisse sind auch als `*_FILE` möglich.
- Lizenz **AGPL-3.0-or-later** (`LICENSE`). „OpenPlancraft“ ist nur Arbeitstitel: Produktname, Image- und Paketnamen nie verstreut hart codieren, sondern zentral konfigurieren, damit die Umbenennung vor dem Release einfach bleibt.
- Keine Telemetrie ohne Opt-in. Keine Lizenzschlüssel oder Feature-Sperren im Code.
- Abhängigkeiten nur mit OSI-kompatibler Lizenz, die zur Projektlizenz passt (AGPL-kompatibel; keine SSPL/BSL).
- Migrationen müssen automatisch, idempotent und vorwärtskompatibel laufen (Upgrade-Test in CI). Betreiber führen keine manuellen SQL-Schritte aus.
- Änderungen am Betrieb (neuer Container, neues Volume, neue Variable) brauchen ein Update in `docs/self-hosting/` und einen Changelog-Eintrag.

## Unverletzliche Regeln (Compliance & Sicherheit)
1. **Geld nie als Float.** Beträge sind `bigint` Cent (`*_cents`), Mengen `numeric(18,4)`, Rechnen mit `decimal.js`. Rundung kaufmännisch auf Cent, USt pro Steuersatz auf Summenebene.
2. **Festgeschriebene Dokumente sind unveränderlich.** Kein Code-Pfad darf `UPDATE`/`DELETE` an finalisierten Rechnungen oder deren Positionen ausführen. Korrektur = Storno + neue Rechnung. DB-Trigger sind die letzte Verteidigungslinie und dürfen nie abgeschaltet werden.
3. **Rechnungsnummern** werden erst beim Festschreiben vergeben, in derselben Transaktion, lückenlos (`SELECT … FOR UPDATE` auf `number_sequence`). Entwürfe haben keine Nummer.
4. **Snapshots**: Beim Festschreiben werden Kunden-, Adress-, Firmen- und Steuerdaten in das Dokument kopiert. Finalisierte Dokumente lesen nie live aus `customer`.
5. **Mandantentrennung**: jede fachliche Tabelle hat `tenant_id` und eine RLS-Policy. Jede neue Tabelle braucht RLS + einen Test, dass Mandant B die Daten von A nicht sieht. Niemals `BYPASSRLS` für den App-User.
6. **Audit-Log** ist append-only mit Hash-Kette. Jede Änderung steuerrelevanter Daten schreibt ein `audit_event` in derselben Transaktion.
7. **Löschen** steuerrelevanter Daten vor Ablauf der Aufbewahrungsfrist (Standard 10 Jahre) ist verboten. Nur Sperren/Archivieren.
8. **E-Rechnungen** (ZUGFeRD EN 16931 / XRechnung) müssen den KoSIT-Validator bestehen, bevor sie versendet oder archiviert werden. Das Original (PDF/A-3 bzw. XML) wird unverändert mit SHA-256 im WORM-Bucket abgelegt.
9. **Sicherheit**: Keine Secrets im Repo. Keine Tokens in `localStorage`. Nur parametrisierte Queries. Alle Eingaben mit Zod validieren. Keine PII in Logs. Uploads prüfen (MIME, Größe). Berechtigungen serverseitig prüfen (RBAC laut DESIGN.md §5.2), nie nur im UI verstecken.
10. **Idempotenz**: Alle POST-Endpunkte akzeptieren `Idempotency-Key` (Offline-Sync, Doppelklick beim Festschreiben).
11. **Aufmaß-Formeln** werden ausschließlich mit dem eigenen Parser in `packages/domain` ausgewertet – niemals `eval`, `new Function` o. Ä. Der Server berechnet `result_qty` immer selbst neu; Client-Ergebnisse sind nur Vorschau.
12. **Abrechnungsgrundlagen sind gesperrt**: Aufmaßzeilen, die in einer festgeschriebenen Rechnung verwendet wurden, und unterschriebene Aufmaßblätter sind unveränderlich (Korrektur nur per Korrekturzeile/neuem Blatt). Rechnungen enthalten nur Positionen aus Hauptauftrag und **beauftragten** Nachträgen (freie Positionen nur mit Warnung).

Wenn eine Anforderung einer dieser Regeln widerspricht: nicht umsetzen, sondern nachfragen.

## Konventionen
- **Code, Bezeichner, Commits auf Englisch; UI-Texte und Fachdokumentation auf Deutsch.** UI-Strings über i18n-Keys (`de-DE` als Basis), nie hart im Code.
- Fachbegriffe im Code laut Glossar unten konsistent verwenden.
- DB: `snake_case`, Tabellennamen im Singular, UUIDv7-Primärschlüssel, `created_at`/`updated_at` (`timestamptz`), Belegdatum als `date`.
- API: REST `/api/v1`, Fehler als RFC 9457 Problem Details mit deutschem `detail`, Cursor-Paginierung, `ETag`/`If-Match` für Entwürfe.
- Einheiten nur aus der Tabelle `unit` (Systemeinheiten siehe DESIGN.md §4.2.1). Jede Einheit braucht einen UN/ECE-Code für die E-Rechnung. Keine Einheiten als freie Strings in Positionen.
- Frontend: Mobile-first. Touch-Ziele ≥ 44 px (Baustellen-Screens 56 px). Jede neue Seite muss auf 375 px Breite ohne horizontales Scrollen funktionieren. Beträge mit `tabular-nums` und `Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' })`.
- Komponenten aus `packages/ui` verwenden. Farben und Abstände nur über Design-Tokens (DESIGN.md §7.2).
- Zugänglichkeit WCAG 2.2 AA: Labels, Fokusreihenfolge, Kontraste, Tastaturbedienung.
- Neue Architekturentscheidungen als ADR in `docs/adr/NNNN-titel.md`.
- Kleine, fokussierte Commits (Conventional Commits: `feat:`, `fix:`, `chore:` …).

## Tests – was immer getestet werden muss
- Kalkulations- und Steuerformeln mit Referenzbeispielen (inkl. § 13b, Abschlagsanrechnung, Alternativpositionen, Rundung).
- Aufmaß-Formelparser (deutsches Zahlenformat, Klammern, Abzüge, Variablen, Fehlerfälle, Fuzzing) und Mengenfortschreibung (kumuliert − bereits abgerechnet).
- Vertragssumme = Hauptauftrag + beauftragte Nachträge; nicht beauftragte Nachträge sind nicht abrechenbar.
- Nummernkreise unter Parallelität (keine Lücken, keine Duplikate).
- Trigger: Änderung an finalisierten Dokumenten schlägt fehl.
- RLS-Isolation pro neuer Tabelle.
- E-Rechnungs-Ausgabe gegen KoSIT-Validator.
- E2E der Kernflüsse auf Mobil- und Desktop-Viewport.

## Glossar (Deutsch → Code)
| Fachbegriff | Code |
|---|---|
| Mandant / Firma | `tenant` |
| Kontakt (Person/Organisation) / Kunde | `contact` (`kind`: `person`, `organization`); Kunde = Kontakt mit Kundennummer |
| Ansprechpartner | `contact_link` (Person ↔ Organisation) |
| Abweichender Rechnungsempfänger | `contact_address.kind = billing` (`recipient_block`) |
| Projekt / Baustelle | `project` (`site_address`) |
| Angebot | `quote` |
| Kostenvoranschlag | `cost_estimate` |
| Leistungsort | `place_of_performance` |
| Auftragsbestätigung | `order_confirmation` |
| Rechnung | `invoice` (`invoice_kind`: `standard`, `partial`, `progress`, `final`) |
| Abschlagsrechnung | `invoice` mit `invoice_kind = progress` |
| Schlussrechnung | `invoice` mit `invoice_kind = final` |
| Stornorechnung | `invoice` mit `cancels_document_id` |
| Gutschrift | `credit_note` |
| Lieferschein | `delivery_note` |
| Leistungsverzeichnis (LV) / Position / Titel | `document_item` (`position_type`: `title`, `item`, `alternative`, `optional`, `lump_sum`, `text`, `subtotal`) |
| Ordnungszahl (OZ) | `oz` |
| Einheitspreis / Gesamtpreis | `unit_price_cents` / `total_cents` |
| Stundenverrechnungssatz | `hourly_rate_cents` |
| Aufschlag | `markup_percent` |
| Lohn / Material / Gerät / Fremdleistung | `labor` / `material` / `equipment` / `subcontract` |
| Festschreiben | `finalize` |
| Einheit / Gebinde / Gebindeinhalt | `unit` / `dimension = container` / `pack_size` |
| Hauptauftrag / Vertragssumme | `contract` / `contract_total_cents` |
| Nachtrag (Nachtragsangebot) | `change_order` (`change_order_meta.basis`: `changed_work`, `additional_work`, `quantity_variance`, `bgb_650b`, `other`) |
| Stammdaten: Leistung / Material | `catalog_item` (`kind`: `service`, `material`) |
| Lohngruppe | `wage_group` |
| Zuschlag (Einstellung) | `surcharge` |
| Kalkulationsmodus Einheitspreis / Gesamtpreis | `calc_mode`: `unit_price`, `total_price` |
| Bericht / Berichtsvorlage | `report` / `report_template` (`billable`) |
| Bautagebuch (Bautagesbericht) | `report` mit Systemvorlage `daily_site_report` |
| Regiebericht | `report` mit Systemvorlage `daywork_report` |
| Bedenken- / Behinderungsanzeige | Systemvorlagen `concern_notice` / `obstruction_notice` |
| Ablage | `file` / `filing_template` |
| Bezahlcode (GiroCode) | `payment_qr` |
| Feiertage / Arbeitszeiten | `holiday_calendar` / `working_hours` |
| Aufmaß / Aufmaßblatt | `measurement` / `measurement_sheet` (`kind`: `survey` = Angebotsaufmaß, `performance` = Leistungsaufmaß) |
| Aufmaßzeile / Raum | `measurement_line` / `measurement_location` |
| Gemeinsames Aufmaß | `measurement_sheet.status = signed` |
| Mehr-/Mindermenge | `quantity_variance` |
| Zahlung / Zahlungseingang | `payment` |
| Abzug / Kürzung (Forderung) | `receivable_adjustment` (`kind`: `cash_discount`, `retention`, `bank_fee`, `short_payment`, `other`) |
| Offene Forderung | `open_amount_cents` |
| Zahlungserinnerung / Mahnung | `dunning_notice` (`level`: `reminder`, `first`, `final`) |
| Kumulative Abschläge | `progress_billing_mode`: `cumulative`, `individual` |
| Sicherheitseinbehalt | `retention` |
| Steuerschuldnerschaft des Leistungsempfängers (§ 13b UStG) | `tax_mode = reverse_charge_13b` |
| Leitweg-ID | `buyer_reference` |
| Datenträgerüberlassung (Z3) | `gobd_export` |
