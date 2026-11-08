# CLAUDE.md – Arbeitsanweisungen für OpenPlancraft

OpenPlancraft ist eine webbasierte Betriebssoftware (ERP) für Bau- und Handwerksbetriebe: Kunden, Projekte, Angebotskalkulation, Rechnungen (GoBD, E-Rechnung), Bautagebuch, Steuerberater- und Finanzamtsexport.

**Lies vor jeder größeren Änderung [`DESIGN.md`](DESIGN.md)** (Architektur, Datenmodell, UX). Hintergrund: [`docs/RESEARCH.md`](docs/RESEARCH.md). Dieses Projekt ist ein eigenständiges Produkt: übernimm keine Texte, Logos, Markennamen oder Screens von Plancraft oder anderen Anbietern.

## Projektstatus
Planungsphase. Es gibt noch keinen Code. Implementiert wird in der Reihenfolge der MVP-Module in DESIGN.md §2.

## Stack (Kurzfassung)
TypeScript strict · pnpm + Turborepo · Fastify · Zod · PostgreSQL 17 + Drizzle · BullMQ/Redis · S3 (EU, Object Lock) · React 19 + Vite + TanStack Router/Query · Tailwind 4 + Radix/shadcn · vite-plugin-pwa + Dexie · Vitest, Testcontainers, Playwright.

## Struktur
```
apps/api  apps/worker  apps/web
packages/domain  packages/schemas  packages/db  packages/einvoice
packages/exports  packages/pdf-templates  packages/ui
infra/  docs/
```
- `packages/domain` enthält **reine** Logik (Kalkulation, Steuern, Summen) ohne I/O. Dort gilt 100 % Testabdeckung.
- `packages/schemas` ist die einzige Quelle für API-Verträge. Frontend und Backend importieren von dort.

## Befehle (Soll, sobald das Scaffolding steht)
```bash
pnpm install
pnpm dev            # docker compose (postgres, redis, minio, kosit) + api + worker + web
pnpm test           # vitest (unit)
pnpm test:int       # integration mit Testcontainers
pnpm test:e2e       # playwright, mobile + desktop
pnpm lint && pnpm typecheck
pnpm db:generate    # drizzle Migration erzeugen
pnpm db:migrate
```
Vor jedem Commit: `pnpm lint && pnpm typecheck && pnpm test`.

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
| Sicherheitseinbehalt | `retention` |
| Steuerschuldnerschaft des Leistungsempfängers (§ 13b UStG) | `tax_mode = reverse_charge_13b` |
| Leitweg-ID | `buyer_reference` |
| Datenträgerüberlassung (Z3) | `gobd_export` |
