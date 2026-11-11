# CLAUDE.md – Arbeitsanweisungen für OpenPlancraft

OpenPlancraft ist eine **Open-Source**-Betriebssoftware (ERP) für Bau- und Handwerksbetriebe, die Firmen **selbst per Docker** auf eigener Infrastruktur betreiben: Kunden, Projekte, Angebotskalkulation, Rechnungen (GoBD, E-Rechnung), Bautagebuch, Steuerberater- und Finanzamtsexport.

**Lies vor jeder größeren Änderung [`DESIGN.md`](DESIGN.md)** (Architektur, Datenmodell, UX). Hintergrund: [`docs/RESEARCH.md`](docs/RESEARCH.md). Dieses Projekt ist ein eigenständiges Produkt: übernimm keine Texte, Logos, Markennamen oder Screens von Plancraft oder anderen Anbietern.

## Projektstatus
Grundgerüst steht, Datenbankschema für das MVP ist angelegt (Migrationen 0001–0025). Rechenlogik (`packages/domain`), Ersteinrichtung, Anmeldung (Sitzung, TOTP, WebAuthn/Sicherheitsschlüssel als zweiter Faktor und Passkey, Rate-Limit, erzwungene Admin-2FA), Benutzerverwaltung mit Einladungen, API für Kontakte und Projekte, Projektanlage, Projektablage (Ordner, Upload, ADR 0004) Dokumente mit Leistungsverzeichnis, Kalkulation je Position, Fertigstellen (Angebot/KV/AB/Nachtrag) und Festschreiben von Rechnungen (Pflichtangaben, Abschläge, Schlussrechnung, `billing.ts`, `routes/invoices.ts`), Storno und „Rechnung korrigieren“ (`POST /documents/:id/cancel`), Nachtrag-Schalter, Briefpapier nach DIN 5008 Form B (A4) mit WYSIWYG-Editor und Druckansicht darauf (`apps/web/src/letter.tsx`, `packages/domain/src/letterhead.ts`, PDF/A-3b mit Typst: `packages/pdf-templates`, `GET /documents/:id/pdf`, ADR 0006) Aufmaß (Blätter, Räume, Formelzeilen, Mengenübernahme, gemeinsames Aufmaß) Bautagebuch (Berichte aus Vorlagen, Fotos, Unterschrift) handschriftliche Unterschriften (Zeichenfeld für Stift/Finger/Maus, „Meine Unterschrift“ im Konto, `routes/signatures.ts`, `apps/web/src/signature.tsx`) E-Rechnung (ZUGFeRD EN 16931 im PDF/A-3 + XRechnung UBL/CII, Prüfung mit KoSIT beim Festschreiben, ADR 0007, `packages/einvoice`, `apps/api/src/einvoice.ts`), Kontakt bearbeiten (Anschrift, Steuer, E-Rechnungsdaten) revisionssicheres Belegarchiv (S3 Object Lock, MinIO im Stack oder externer S3, ADR 0008, Worker `apps/worker/src/archive.ts`, nächtlicher Archiv-Abgleich und Umzug auf anderen S3, vorgebaute Images in ghcr.io) mit Belegen in GoBD-/DATEV-/Vollexport, Zahlungen & Forderungen (Zahlungen, Abzüge/Kürzungen, Gegenbuchung, Status, Rechnungsliste mit Summen/CSV, GiroCode im PDF; keine Buchhaltung), Mahnwesen (Zahlungserinnerung → 1. → letzte Mahnung, Verzugszinsen § 288 BGB, PDF/A, E-Mail mit Anhang), nächtliche Prüfung der Audit-Kette, Bereich „Prüfung“ (Änderungsprotokoll) und befristeter Prüferzugang Stammdaten mit DATANORM-Katalogen, Einstellungen, optionaler E-Mail-Versand (SMTP, Postausgang) und Exporte (DATEV, GoBD Z3, Vollexport), Sicherung/Wiederherstellung mit Betriebs-Check sowie die Weboberfläche dazu sind fertig. Monorepo, Services (`server` = API + Worker per `APP_ROLE`), Web-Platzhalter, Docker-Stack (proxy, app, db, kosit, storage, backup, Volumes `files`/`backups`/`archive-data`; Profil `standard` mit separatem `worker`; externer S3 per `compose.external-s3.yaml`), Test-Stack und CI. Was fehlt und in welcher Reihenfolge: Abschnitt **„Offene Punkte nach Priorität“** unten.

## Offene Punkte nach Priorität (Stand 2026-11-11, Migration 0025)
**Pflege:** Diese Liste ist das Gedächtnis zwischen Chats. Erledigtes hier streichen (und unter „Projektstatus“ ergänzen), neue Erkenntnisse eintragen, Datum/Migrationsstand oben aktualisieren. Reihenfolge innerhalb einer Stufe = empfohlene Bearbeitungsreihenfolge.

**Zuletzt erledigt:** Einstellungen-UI, E-Mail-Postausgang (SMTP), Exporte (DATEV/GoBD/Vollexport), Backup-Dienst + `infra/restore.sh` + Betriebs-Check, Storno-Sperre in der DB (0015: stornierte Rechnung bleibt mit Nummer erhalten, gesperrt, ausgegraut; Nummern nie wiederverwendet), Nummernkreis je Jahr + frei wählbares Schema `{Jahr}`/`{JJ}`/`{Monat}`/`{Nummer}` (0016, `packages/domain/src/numbering.ts`, `next_number` überspringt vergebene Nummern), Rechnungen festschreiben mit § 14-Prüfung, Abschlägen und Schlussrechnung (0017), Storno/„Rechnung korrigieren“, Briefpapier-Editor DIN 5008 B / A4 mit Logo (0018), PDF/A-3b mit Typst (ADR 0006), Aufmaßblatt und Berichte als PDF/A (`packages/pdf-templates/src/site.ts`, `GET /measurement-sheets/:id/pdf`, `GET /reports/:id/pdf`), handschriftliche Unterschriften (0019: `user_signature` je Nutzer, Bilder als `tenant_asset` Art `signature`, nur vom Ersteller verwendbar; Bild im PDF über der Linie), **E-Rechnung** (0020, ADR 0007: ZUGFeRD/Factur-X EN 16931 in jeder Rechnung, XRechnung UBL/CII bei Leitweg-ID oder Kundenwunsch; KoSIT-Container `kosit` prüft beim Festschreiben in derselben Transaktion, abgelehnt/nicht erreichbar = Rollback ohne Nummer; XML + Prüfbericht als `document_artifact`, DB-Constraint „nur geprüft“; Storno = Typ 384; Factur-X-XMP per inkrementellem PDF-Update; Mustang/veraPDF lokal: gültig), **Belegarchiv WORM** (0021, ADR 0008: MinIO aus Quellcode gebaut, da keine Images mehr; eigener SigV4-Client `packages/storage/src/s3.ts`; Worker kopiert `document_artifact` per Outbox `pending_archive_artifacts()` mit COMPLIANCE-Lock bis Fristende, Nachweis `artifact_archive`; Lesen mit Rückfall auf das Archiv; Belege in GoBD Z3 (`belege/`, `belege.csv`), DATEV-ZIP und Vollexport), **Zahlungen & Forderungen** (0022: `packages/domain/src/receivables.ts` mit `receivableState`/`settlementSuggestion`, `girocode.ts`; API `routes/receivables.ts`: `POST /documents/:id/payments|adjustments|retention-release`, `POST /payments|adjustments/:id/reverse`, `GET /invoices` (+ `export.csv`); nie löschen, nur Gegenbuchung; UI `screens/payments.tsx`, `screens/invoices.tsx`; bewusst keine Buchhaltung; DATEV-Export enthält Zahlungen und anerkannte Kürzungen `short_payment`/`other` als Erlösminderung, nie Skonto/Einbehalt/Bauumlage/Bankgebühr/bestrittene), **Mahnwesen** (0023: `packages/domain/src/dunning.ts` mit `dunningAmounts`/`defaultInterest`, Basiszinstabelle `base_interest_rate` (Release-Zeilen ohne Mandant + eigene), API `routes/dunning.ts`: `GET /documents/:id/dunning`, `POST …/dunning(/preview)`, `GET /dunning-notices/:id/pdf`, `POST /dunning-notices/:id/email`, Einstellungen `/settings/dunning`, `/settings/base-interest-rates`; Mahnung sofort festgeschrieben, PDF/A als `document_artifact` `dunning_pdf` (6 Jahre), E-Mail-Anhänge `email_attachment`; UI `screens/dunning.tsx`, Einstellungen › Mahnungen), **Audit-Kette & Prüfer** (0024: `audit_chain_check` + `check_audit_chain()`/`check_all_audit_chains()` mit Anker (Nummer + Hash des letzten Eintrags → erkennt `broken`/`truncated`/`rewritten`), Worker-Job `audit.check-chain` täglich 02:17 Europe/Berlin (`apps/worker/src/audit.ts`), API `routes/audit.ts` (`GET /audit/events`, `GET /audit/chain`, `POST /audit/chain/check`, Recht `audit.read`), Betriebs-Check `audit`; Audit-Trigger auch für `tenant`, `tax_rate`, `payment_term`; Prüferrolle `auditor` nur mit `membership.valid_until` (Trigger, API max. 1 Jahr, `invitation.access_until`); UI `screens/audit.tsx` Tab „Prüfung“ mit Exporten), **Archiv-Abgleich** (0025: `apps/worker/src/archive-verify.ts` `verifyArchive()`/`verifyRequested()`: HEAD (vorhanden, SHA-256-Metadatum, Größe, Sperrfrist) + jedes 10. per Download; fehlend/beschädigt → neu schreiben (neue Version, ursprüngliche Frist) aus Arbeitskopie oder `ARCHIVE_PREVIOUS_S3_*`, sonst `lost`; Ergebnisse `artifact_archive_check`, vollständiger Abgleich je Firma `archive_verify_request` (nach `restore.sh`, Betriebs-Check-Knopf, `infra/archive-reconcile.sh`, einmal nach Update); pg-boss `archive.verify` 03:47 Europe/Berlin, 500 Objekte; `MemoryArchiveStore` versioniert wie S3 mit Object Lock; Images-Workflow `.github/workflows/images.yml` → ghcr.io `edge`/Versionen, amd64+arm64). PDF/A-Prüfung: Typst prüft beim Export, Test prüft die Kennung; veraPDF bewusst nicht im Betriebs-Stack (höchstens optionaler CI-Schritt mit ZUGFeRD).

### P1 – Pflicht vor dem Echtbetrieb (Rechnungen, Recht, GoBD)
10. **Mit echten Daten verifizieren** (steht aus): DATEV-Import beim Steuerberater, `index.xml` gegen `gdpdu-01-09-2004.dtd`, DATANORM-Dateien eines Großhändlers; E-Rechnung mit einem echten Empfänger (Rechnungseingangsplattform des Bundes/Landes, ZUGFeRD-Import einer Buchhaltung). Fachlich klären: Sicherheitseinbehalt/Bauumlage stehen in der E-Rechnung nur als Hinweis (BT-115 = Brutto).

### P2 – Wichtig für den Alltag
1. **Dokumente per E-Mail versenden** (Postausgang `kind = document` und Anhänge `email_attachment` → `document_artifact` vorhanden, wie bei Mahnungen) mit PDF-Anhang (Rechnungen: das archivierte ZUGFeRD-PDF), XRechnung als XML-Anhang an `contact.einvoice_email`, Vorlagen, BCC; Status „versendet“ automatisch.
2. **Mahnvorschläge**: Liste der Rechnungen, für die die nächste Mahnstufe fällig ist (Filter in der Rechnungsliste, Stufe als Spalte), Sammelversand; Mahnstufe im Dashboard.
3. **Offline/PWA für Baustelle** (vite-plugin-pwa + Dexie, Outbox mit Idempotency-Key): Aufmaß, Bautagebuch, Fotos (DESIGN.md §6 Offline-Sync).
4. **Eingangsrechnungen Basisversion** (E-Rechnungs-Empfang ist seit 2025 Pflicht): Upload PDF/XML, lesbare Darstellung, Zuordnung Projekt/Betriebsbereich, Archiv.
5. **Weitere Berichte in der UI**: Regie-/Einsatzbericht (abrechenbar → in Rechnung übernehmen), Abnahmeprotokoll, Bedenken-/Behinderungsanzeige (API vorhanden, nur Bautagebuch hat UI).
6. **Nachträge ausbauen**: Anlegen aus Bautagebuch/Aufmaß-Mehrmengen, Nachweise verknüpfen, Übersicht offene/beauftragte Nachträge, Vertragssumme `/projects/:id/contract`.
7. **Projektkennzahlen & Listenfilter**: Soll-Stunden, Auftragssumme, abgerechnet, offen; Filter Zeitraum/Status/Mitarbeitende.
8. **Dashboard, globale Suche, Benachrichtigungen** (DESIGN.md §2).
9. **Kontakte vervollständigen**: Bearbeiten von Name, Hauptanschrift, Steuerfall, USt-IdNr. und E-Rechnungsdaten gibt es (`screens/contact-editor.tsx`); es fehlen weitere Anschriften (abweichender Rechnungsempfänger), Kanäle (E-Mail/Telefon), Ansprechpartner, Zahlungsbedingungen, Archivieren, CSV-Import/-Export, Filter.
10. **Konto**: Passwort vergessen und E-Mail-Bestätigung (braucht SMTP, sonst Admin-Reset).
11. **Einstellungen ergänzen**: Feiertage nach Bundesland (Tabelle `holiday_calendar` existiert), Lohnkostenanteil § 35a, Abschlagsregeln, automatische Anhänge, Dateinamen-Muster, Hinweisleiste für fehlende Pflichtangaben.
12. **Angebot**: Zielpreis („Preis anpassen“), Bilder als Positionstyp, Versionen, „in Stammdaten speichern“; Stammdaten CSV-Import/-Export.

### P3 – Betrieb, Qualität, Release
0. Beobachten: `apps/worker/src/email.integration.test.ts` schlug einmal direkt nach einem Docker-Neustart fehl (gemeinsame Test-DB), danach stabil. Falls es wieder auftritt: Test auf eigene Mandanten beschränken statt Postausgang aller Firmen zu zählen.
1. Upgrade-Test der Migrationen in CI, E2E für Einstellungen/Exporte/Storno/Backup, Nummernkreise unter Parallelität für Rechnungen; optionaler CI-Schritt: ZUGFeRD-PDFs mit Mustang/veraPDF prüfen (lokal einmal gültig, siehe ADR 0007).
2. `packages/ui` mit Komponenten und Design-Tokens (DESIGN.md §7.2) statt Einzel-CSS; OpenAPI aus Zod generieren.
3. Sicherung verschlüsselt außer Haus (z. B. restic als Option), Hinweis im Betriebs-Check.
4. DSGVO-Löschkonzept (Sperren bis Fristende, danach automatisch löschen), Auskunft; Vorlage Verfahrensdokumentation in `docs/verfahrensdokumentation/`.
5. Benutzerhandbuch (Deutsch) für Büro und Baustelle.
6. Vor dem ersten Release: endgültigen Produktnamen festlegen und zentral umstellen (ADR 0001).
7. Images in ghcr.io: nach dem ersten Lauf von `images.yml` die vier Pakete in den GitHub-Paketeinstellungen auf **öffentlich** stellen (neue Pakete sind privat); erstes Release `v0.1.0` taggen, damit `latest` existiert.

### Phase 2/3 (nach dem MVP, DESIGN.md §2)
Zeiterfassung · Plantafel · Nachkalkulation · GAEB DA XML / REB-Aufmaßaustausch · Mahnbescheid-Export · Kundenportal mit Online-Annahme · Projekt-Chat · Österreich (ebInterface) · Bankanbindung · KI-Funktionen (Angebotsentwurf, Sprach-Bautagebuch/-Aufmaß, Belegerkennung).

### Offene Entscheidungen (beim Nutzer erfragen, nicht raten)
Österreich im MVP? · GoBD-Testat (IDW PS 880)? · Eingangsrechnungen ins MVP (Vorschlag: ja, Basis)? · Schlussrechnung: alle gestellten oder nur bezahlte Abschläge abziehen (mit Steuerberater klären)? · ~~Speicher für WORM-Archiv~~ (entschieden: MinIO Standard, externer S3 optional, ADR 0008).

## Stack (Kurzfassung)
TypeScript strict · pnpm + Turborepo · Fastify · Zod · PostgreSQL 17 (SQL-Migrationen, ADR 0003) · pg-boss (Queue in PostgreSQL) · Typst (PDF/A-3) · S3 via MinIO (Object Lock) · Caddy · Docker Compose · React 19 + Vite + TanStack Router/Query · Tailwind 4 + Radix/shadcn · vite-plugin-pwa + Dexie · Vitest, Testcontainers, Playwright.

## Struktur
```
apps/server   Composition Root: startet API und/oder Worker je nach APP_ROLE (all|api|worker)
apps/api      Fastify-App (buildApi), ohne eigenen Prozessstart → mit inject() testbar.
              routes/ (auth, auth-common, webauthn, users, contacts, projects, documents, invoices, letterhead, pdf, signatures, files, measurements, reports, catalog, settings, email, exports, operations), billing.ts,
              einvoice.ts (E-Rechnung beim Festschreiben, Downloads), kosit.ts (Validator-Client), artifacts.ts (Archiv), security/ (crypto, passwords, sessions),
              testing/ (Test-Harness, Software-Authenticator für WebAuthn), context.ts
              (requireAuth, requirePermission, inTenant), http.ts (HttpError, parse, Cursor, ETag), idempotency.ts
apps/worker   pg-boss-Jobs (startWorker), E-Mail-Versand aus dem Postausgang (email.ts), Belegarchivierung (archive.ts, alle 30 s)
apps/web      React/Vite-PWA (screens/, router.ts, webauthn.ts, i18n.ts)
e2e/          Playwright-Tests gegen einen laufenden Stack (virtueller FIDO2-Schlüssel per CDP)
packages/config  Env-Schema (zod) – einzige Stelle für Konfiguration
packages/db      SQL-Migrationen (migrations/), Runner, createSql (runtime/admin), withTenant(), Readiness
packages/domain  Reine Rechenlogik: Aufmaß-Formeln, Aufmaßzeilen/Mengen, Kalkulation (Position, Dokument, Zielpreis, Gebinde), Einheiten, DATANORM-Leser (catalog/datanorm.ts)
packages/schemas Zod-Schemas und DTO-Typen der API (Server + Web); `@opc/schemas/constants` ohne zod für Werte im Web
packages/exports Exportformate ohne I/O-Abhängigkeiten: ZIP-Stream, CSV, DATEV-Buchungsstapel, GoBD index.xml
packages/storage Dateiablage: ObjectStore (Dateisystem), Upload-Typprüfung, Dateinamen (ADR 0004); Belegarchiv: `S3Client` (SigV4), `S3ArchiveStore` (Object Lock), `MemoryArchiveStore` (Tests), `retainUntilOf()` (ADR 0008)
packages/pdf-templates Typst-Vorlage `templates/letter.typ` (DIN 5008 B, A4; Bausteine heading/text/facts/table/images/signatures; Anhang factur-x.xml), Schriften in `fonts/`, `renderLetterPdf()` (PDF/A-3b), `documentLetter()`, `sheetLetter()`, `reportLetter()`, `letterFrame()`
packages/einvoice E-Rechnung ohne I/O: `einvoiceFromDocument()` (EN 16931 aus dem festgeschriebenen Dokument), `toCii()` (ZUGFeRD/XRechnung CII), `toUbl()` (XRechnung UBL), `einvoiceProblems()` (Vorprüfung), `addFacturXMetadata()` (XMP per inkrementellem Update), `parseKositReport()`
geplant: packages/ui
docker/ (Dockerfiles app, web, kosit, storage)  infra/ (Caddyfile, smoke-test.sh, backup/backup.sh, restore.sh)  docs/
```
- Pakete exportieren über die Condition `source` direkt TypeScript (Entwicklung, Tests); gebaut wird nach `dist/`. Imports innerhalb eines Pakets mit `.js`-Endung (NodeNext).
- Rechnungen: Rechenlogik in `packages/domain/src/calculation/billing.ts` (Mengenfortschreibung, § 14-Prüfung, Pflichthinweise) und `document.ts` (Abzüge je Steuersatz), Datenzugriff in `apps/api/src/billing.ts`. Herkunft einer Position über `document_item_root()` (Kette `source_item_id`). Abgezogen werden nur festgeschriebene, nicht stornierte Abschlags-/Teilrechnungen (`DEDUCTED_INVOICE_KINDS`); USt der Rechnung auf den Restbetrag; Einbehalt/Bauumlage auf den Restbetrag brutto (fachlich mit Steuerberater bestätigen).
- Briefpapier: Layout je Firma in `letterhead` (jsonb, Positionen in mm, Papier A4), Logos und Unterschriften in `tenant_asset` (nur einfügen, nie löschen; Unterschrift = `kind = signature`, PNG, darf nur von `created_by` verwendet werden, Prüfung `ownSignature()` in `routes/signatures.ts`). `liveIssuer()` liefert Layout + Platzhalterwerte; beim Festschreiben landen sie in `issuer_snapshot`. Die IBAN wird über `servicesOf(tx)` (aus `inTenant`) entschlüsselt. Druck: `LetterPage`/`ScaledPage` in `apps/web/src/letter.tsx`.
- E-Rechnung (Regel 8, ADR 0007): `finalizeInvoice`/`cancelInvoice` rufen nach Nummer und Snapshots `issueEinvoices()` auf: XML je Format bauen, KoSIT (`services.einvoiceValidator`) prüft, erst dann XML + Prüfbericht ablegen; Fehler → Rollback. Snapshots enthalten dafür strukturierte Daten (`issuer.address`, `issuer.einvoice`, `recipient.address`, Kundennummer, Leitweg-ID, Format). Das Rechnungs-PDF bettet genau das archivierte XML ein (`zugferd_pdf`). Neue Pflichtangaben für die E-Rechnung gehören in `einvoiceProblems()`, damit sie vor dem Festschreiben angezeigt werden. Integrationstests mit `KOSIT_URL` nutzen den echten Validator, sonst `acceptingValidator` aus dem Test-Harness.
- Belegarchiv (Regel 7/8, ADR 0008): Jedes `document_artifact` wird vom Worker in den Bucket kopiert (`archivePending`), nie in der Festschreibe-Transaktion. Der Archiv-Abgleich (`verifyArchive`) schreibt nur mit unveränderter Quelle (SHA-256 wie beim Festschreiben) und nie mit kürzerer Frist. Neue Original-Arten brauchen nur eine `document_artifact`-Zeile; lesen immer über `openArtifact()` (Arbeitskopie, sonst Archiv). Tests: mit `ARCHIVE_S3_ENDPOINT` echter MinIO (Docker-Pipeline), sonst `MemoryArchiveStore`.
- Mahnungen: Beträge nur aus `dunningAmounts()` (Domain) auf Basis von `receivableState`; eine ausgestellte Mahnung ist unveränderlich (Trigger 0023), Korrektur höchstens durch die nächste Stufe. Neue Basiszinssätze (1.1./1.7., Bundesbank) als Migration mit `tenant_id = NULL` nachtragen.
- Forderungen (keine Buchhaltung!): Zahlungen/Abzüge nur je Rechnung, nie `UPDATE`/`DELETE` (Trigger 0022, Ausnahme Kennzeichen `disputed`); Korrektur per Gegenbuchung. Status und offener Betrag kommen immer aus `receivableState()` (Domain), nie aus eigener SQL-Logik; „heute“ über `todayOf(tx)` (Uhr der Services, Europe/Berlin).
- PDF: Inhalte gehen als JSON in die Typst-Vorlage und werden nur als Text gesetzt (nie Markup auswerten). Festgeschriebene Dokumente: einmal rendern, als `document_artifact` (Art `pdf`) ablegen, danach immer dieses Original ausliefern (`routes/pdf.ts`).
- `packages/domain` enthält **reine** Logik (Kalkulation, Steuern, Summen) ohne I/O. Dort gilt 100 % Testabdeckung.
- `packages/schemas` ist die einzige Quelle für API-Verträge. Frontend und Backend importieren von dort.

## Befehle
```bash
pnpm install
docker compose -f compose.yaml -f compose.dev.yaml up -d db kosit   # DB (5432) + KoSIT-Validator (8081) in Docker (optional storage: MinIO auf 9000)
DATABASE_URL=postgres://openplancraft:<pw>@localhost:5432/openplancraft KOSIT_URL=http://localhost:8081 pnpm dev   # API+Worker :3000, Web :5173
pnpm lint           # Biome (Lint + Format-Prüfung); pnpm format schreibt Formatierung
pnpm typecheck
pnpm test           # Vitest; *.integration.test.ts laufen nur, wenn DATABASE_URL gesetzt ist; mit KOSIT_URL prüft der echte KoSIT alle E-Rechnungen
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
- Nummern nur über `next_number(kind, datum)` in der Festschreibe-Transaktion. Format kommt aus `number_sequence.pattern` (Schema mit Platzhaltern; `prefix`/`include_year` sind veraltet); bei `reset_yearly` zählt `number_sequence_year` je Jahr.
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
3. **Rechnungsnummern** werden erst beim Festschreiben vergeben, in derselben Transaktion, lückenlos (`SELECT … FOR UPDATE` auf `number_sequence`). Entwürfe haben keine Nummer. Eine vergebene Nummer wird **nie wieder verwendet** – auch nicht nach einem Storno. Die stornierte Rechnung bleibt mit ihrer Nummer erhalten, wird nie gelöscht und ist dauerhaft gesperrt (`status = cancelled`, in der Oberfläche ausgegraut). Das Storno ist eine eigene Rechnung (`invoice_kind = cancellation`, `cancels_document_id`) mit eigener neuer Nummer; erst ihr Festschreiben setzt die Originalrechnung auf `cancelled` (Trigger, Migration 0015).
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
- Storno: Originalrechnung bleibt mit Nummer erhalten, ist gesperrt, Nummer wird nicht erneut vergeben.
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
| Bezahlcode (GiroCode) | `payment_qr` (`giroCodePayload()`, EPC-QR im Rechnungs-PDF) |
| Gegenbuchung (Storno einer Zahlung/eines Abzugs) | `reverses_payment_id` / `reverses_adjustment_id` |
| Feiertage / Arbeitszeiten | `holiday_calendar` / `working_hours` |
| Aufmaß / Aufmaßblatt | `measurement` / `measurement_sheet` (`kind`: `survey` = Angebotsaufmaß, `performance` = Leistungsaufmaß) |
| Aufmaßzeile / Raum | `measurement_line` / `measurement_location` |
| Gemeinsames Aufmaß | `measurement_sheet.status = signed` |
| Mehr-/Mindermenge | `quantity_variance` |
| Zahlung / Zahlungseingang | `payment` |
| Abzug / Kürzung (Forderung) | `receivable_adjustment` (`kind`: `cash_discount`, `retention`, `bank_fee`, `short_payment`, `other`) |
| Offene Forderung | `open_amount_cents` |
| Zahlungserinnerung / Mahnung | `dunning_notice` (`level`: `reminder`, `first`, `final`) |
| Basiszinssatz / Verzugszinsen / Verzugspauschale | `base_interest_rate` / `interest_cents` / `flat_fee_cents` |
| Kumulative Abschläge | `progress_billing_mode`: `cumulative`, `individual` |
| Sicherheitseinbehalt | `retention` |
| Steuerschuldnerschaft des Leistungsempfängers (§ 13b UStG) | `tax_mode = reverse_charge_13b` |
| Leitweg-ID | `buyer_reference` |
| Datenträgerüberlassung (Z3) | `gobd_export` |
| Revisionssicheres Belegarchiv | `artifact_archive` (Bucket mit Object Lock, `services.archive`) |
