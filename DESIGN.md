# OpenPlancraft – Design-Dokument

Version 0.1 · Stand 2026-11-08 · Status: **Entwurf zur Freigabe vor Implementierung**

Grundlage: [`docs/RESEARCH.md`](docs/RESEARCH.md). Arbeitsregeln für Agenten und Entwickler: [`CLAUDE.md`](CLAUDE.md).

---

## 1. Produktvision

**Eine einfache, mobile Betriebssoftware für Bau- und Handwerksbetriebe mit 1–40 Mitarbeitenden.** Sie deckt den Weg vom Kundenkontakt über Angebot, Auftrag und Baustelle bis zur Rechnung und Steuerberater-Übergabe ab, und zwar **rechtssicher (GoBD, E-Rechnung)**, ohne dass der Nutzer davon etwas verstehen muss.

### Leitprinzipien
1. **Das Projekt ist der Mittelpunkt.** Alles (Kunde, Dokumente, Fotos, Bautagebuch, Zahlungen) hängt am Projekt.
2. **Nichts doppelt tippen.** Aufmaß → Angebot → AB → Nachträge → Abschlag → Schlussrechnung werden abgeleitet. Mengen kommen aus dem Aufmaß, nicht aus dem Kopf.
3. **Compliance by default.** Festschreiben, Nummernkreise, Archiv, Audit-Log und Exporte passieren automatisch. Der Nutzer kann nichts GoBD-Widriges tun.
4. **Baustellentauglich.** Große Touch-Ziele, funktioniert offline, bedienbar mit Arbeitshandschuhen und bei Sonnenlicht.
5. **Handwerkersprache.** „Rechnung korrigieren“ statt „Stornobeleg generieren“; Fachbegriffe nur wo üblich (Aufmaß, LV, Abschlag).

### Nicht-Ziele (vorerst)
Vollwertige Finanzbuchhaltung (bleibt beim Steuerberater via DATEV), Lohnabrechnung, BIM/CAD, native Apps im Store (PWA zuerst, später Capacitor-Wrapper).

---

## 2. Funktionsumfang und Roadmap

### Phase 1 – MVP
| Modul | Inhalt |
|---|---|
| **Konto & Firma** | Registrierung, Firmendaten (Steuernr., USt-IdNr., Bank, Logo, Briefpapier), Nummernkreise, Steuersätze, Zahlungsbedingungen, Textvorlagen, Nutzer & Rollen, 2FA |
| **Kunden (CRM)** | Privat- und Geschäftskunden, mehrere Adressen und Ansprechpartner, Notizen, § 13b-Kennzeichen (Kunde ist Bauleistender), Leitweg-ID (öffentliche Auftraggeber), Kundenhistorie |
| **Projekte** | Baustellenadresse, Status (Anfrage → Angebot → Auftrag → In Ausführung → Abgerechnet → Abgeschlossen), Dokumente, Fotos, Bautagebuch, Umsatzübersicht |
| **Leistungs- & Artikelstamm** | Leistungen (Lohn/Material/Gerät/Fremdleistung als Komponenten), Artikel mit EK/VK, Einheiten, Kategorien, CSV-Import |
| **Angebot / Kalkulation** | Hierarchisches LV (Titel/Untertitel/Positionen, OZ automatisch), Positionstypen (Normal, Alternativ, Bedarf/Eventual, Pauschal, Text, Zwischensumme), Kalkulation je Position (Zeit × Stundenverrechnungssatz + Material EK × Aufschlag + Gerät + Fremdleistung), globale Zuschläge, Rabatt, Lohnanteil-Ausweis § 35a, Vorlagen, PDF-Vorschau live, Versand per E-Mail, Versionen |
| **Aufmaß** ⭐ | Aufmaßblätter je Projekt, gegliedert nach Gebäude/Geschoss/Raum; Zeilen mit **Formeln** (z. B. `4,25*2,60 - 0,885*2,01`), Variablen, Abzügen (Öffnungen), Formelvorlagen (Rechteck, Wandfläche aus Raumumfang × Höhe, Dreieck, Kreis, Volumen, Stück); Zuordnung jeder Zeile zu einer LV-Position; Skizze/Foto je Zeile; zwei Arten: **Angebotsaufmaß** (Mengen → Angebot) und **Leistungsaufmaß** (ausgeführte Mengen → Abschlags-/Schlussrechnung); gemeinsames Aufmaß mit Unterschrift des Auftraggebers; Mehr-/Mindermengen gegenüber LV mit Hinweis ab ±10 % (VOB/B § 2 Abs. 3); PDF-Aufmaßblatt als Rechnungsanlage; **offline auf dem Tablet** |
| **Auftragsbestätigung** | 1-Klick aus Angebot; begründet den **Hauptauftrag** (Vertragssumme) |
| **Nachträge** ⭐ | Nachtragsangebote zum Hauptauftrag (N01, N02 …) mit eigenem LV (OZ `N01.0010`), Grund und Rechtsgrundlage (geänderte Leistung VOB/B § 2 Abs. 5, zusätzliche Leistung § 2 Abs. 6, BGB § 650b/c), Verknüpfung zu Bautagebuch-Einträgen, Fotos und Aufmaß als Nachweis; Status Entwurf → angeboten → beauftragt / teilbeauftragt / abgelehnt; Anlegen direkt aus Bautagebuch („Zusatzleistung erkannt“) oder aus Aufmaß-Mehrmengen; beauftragte Nachträge erhöhen die Vertragssumme und sind in Abschlags-/Schlussrechnungen abrechenbar; Übersicht offene/beauftragte Nachträge je Projekt |
| **Rechnungen** | Abschlags-, Teil-, Schluss- und Einzelrechnung, **Mengen aus dem Leistungsaufmaß** (kumuliert, bereits abgerechnete Mengen werden abgezogen), Positionen aus Hauptauftrag **und** beauftragten Nachträgen, Anrechnung vorheriger Abschläge, Sicherheitseinbehalt, Skonto, § 13b-Text, Storno und Korrektur, **ZUGFeRD 2.x (EN 16931) als PDF/A-3 + XRechnung (UBL)**, E-Mail-Versand |
| **Zahlungen** | Manuelle Zahlungserfassung (Teilzahlung), Status offen/teilbezahlt/bezahlt/überfällig, 1 Zahlungserinnerung |
| **Bautagebuch** | Tageseintrag je Projekt: Datum, Wetter (automatisch vorbefüllt), Temperatur, Anwesende (Personen/Kolonnen, Stunden), ausgeführte Arbeiten, Material/Geräte, Besonderheiten/Behinderungen/Mängel, Fotos mit Bildunterschrift, Unterschrift Bauleiter/Auftraggeber, PDF-Export; **offline erfassbar** |
| **Export & Archiv** | DATEV-Buchungsstapel (EXTF CSV) + Belege, GoBD-Datenträgerüberlassung (Z3, CSV + `index.xml`), vollständiger Datenexport (ZIP), revisionssicheres Belegarchiv |
| **Dashboard** | Offene Angebote, offene/überfällige Rechnungen, Umsatz Monat/Jahr, heutige Baustellen |

### Phase 2 – Wachstum
Zeiterfassung (Stempeluhr mobil, je Projekt) · Aufmaß-Austausch (REB 23.003 / GAEB X31, Import aus Laser-Messgeräten/Apps) · Nachtragskalkulation auf Basis der Urkalkulation (Preisfortschreibung) · Mahnwesen mit Stufen · DATANORM 4/5-Import · GAEB DA XML (X83 Import, X84 Export) · Eingangsrechnungen (E-Rechnung-Empfang, PDF-Upload, Projektzuordnung) · Nachkalkulation (Soll/Ist) · Plantafel (Mitarbeiter ↔ Baustellen) · Kundenportal mit Online-Annahme und Signatur · Lieferscheine, Gutschriften · Österreich (USt-Sätze, ebInterface).

### Phase 3 – Komfort & KI
KI-Angebotsentwurf aus Freitext, Sprach-Bautagebuch (Diktat → strukturierter Eintrag), Sprach-Aufmaß („Wand 4,25 mal 2,60 minus Tür“ → Formelzeile), Aufmaß aus Plan-PDF, Belegerkennung, Fotomarkierung, Bankanbindung (FinTS/PSD2) mit Zahlungsabgleich, native App-Hüllen (Capacitor), Wetterhistorie, Mängelmanagement.

---

## 3. Architektur

### 3.1 Überblick

```
┌──────────────────────────────────────────────────────────┐
│  Clients: Browser (Desktop/Tablet/Phone) als PWA         │
│  React + Vite + TanStack · Service Worker · IndexedDB    │
└──────────────┬───────────────────────────────────────────┘
               │ HTTPS (JSON/REST, OpenAPI), Cookies
┌──────────────▼───────────────────────────────────────────┐
│  API (Node 22, Fastify, TypeScript)                       │
│  Module: auth · tenants · customers · projects · catalog  │
│          measurements · documents · change-orders         │
│          invoicing · payments · diary · files · exports   │
│          audit                                            │
├───────────────────┬──────────────────┬───────────────────┤
│  Worker (BullMQ)  │ PostgreSQL 17    │ S3 Object Storage │
│  PDF, E-Rechnung, │ RLS je Mandant   │ (EU), Object Lock │
│  Mails, Exporte   │ Append-only-Log  │ für Archiv (WORM) │
└───────────────────┴──────────────────┴───────────────────┘
          Redis (Queue, Rate-Limit) · SMTP · KoSIT-Validator
```

**Modularer Monolith**: ein deploybares API-Artefakt plus ein Worker-Prozess aus derselben Codebasis. Microservices bringen bei dieser Teamgröße nichts.

### 3.2 Technologie-Stack

| Bereich | Wahl | Begründung |
|---|---|---|
| Sprache | **TypeScript** (strict) durchgängig | Ein Typsystem für Frontend und Backend, geteilte Schemas |
| Monorepo | **pnpm workspaces + Turborepo** | Geteilte Pakete (Schemas, Rechenlogik) |
| Backend | **Fastify** + `@fastify/swagger` | Schnell, schlank, OpenAPI aus Schemas |
| Validierung | **Zod** (geteilt) | Gleiche Validierung im Client und auf dem Server |
| DB | **PostgreSQL 17** | Transaktionen, RLS, Trigger für Unveränderbarkeit, JSONB |
| ORM / Migrationen | **Drizzle ORM** + drizzle-kit | Typsicher, SQL-nah, gut für Trigger/RLS |
| Jobs | **BullMQ** + Redis | PDF-Erzeugung, E-Mail, Exporte, Wetterabruf |
| PDF | HTML-Templates → **Playwright/Chromium** → PDF; Umwandlung in **PDF/A-3** und XML-Einbettung | Pixelgenaue Briefpapiere, ZUGFeRD-fähig |
| E-Rechnung | **`@e-invoice-eu/core`** (Factur-X/ZUGFeRD, XRechnung UBL/CII); Validierung mit **KoSIT-Validator** (Docker-Sidecar, CI) | Bewährte Bibliothek + offizieller Prüfer |
| Dateien | **S3-kompatibel** (z. B. Hetzner Object Storage / IONOS, Region DE), **Object Lock (Compliance-Modus)** für Archivbuckets | WORM-Speicherung für GoBD |
| Frontend | **React 19 + Vite**, **TanStack Router + Query**, **Tailwind CSS 4**, **Radix UI / shadcn-Komponenten** | Schnell, zugänglich, eigenes Designsystem möglich |
| Formulare | React Hook Form + Zod | Gleiche Schemas wie API |
| Offline | **vite-plugin-pwa** (Workbox) + **Dexie** (IndexedDB) + Outbox-Sync | Bautagebuch und Fotos ohne Netz |
| Geld | Ganzzahlige **Cent-Beträge** (`bigint`) + `decimal.js` für Kalkulationen mit Mengen | Keine Float-Rundungsfehler |
| Auth | Eigene Session-Auth: **argon2id**, httpOnly-Secure-SameSite-Cookies, **TOTP-2FA**, später **Passkeys (WebAuthn)** | Keine Tokens in localStorage |
| Tests | **Vitest** (Unit), **Testcontainers** (DB-Integration), **Playwright** (E2E inkl. Mobile-Viewports) | |
| Betrieb | Docker Compose (dev), Container auf EU-Hoster (prod), **Caddy** (TLS), Backups mit **pgBackRest** + WAL-Archivierung | |
| Observability | Pino-Logs (ohne PII), OpenTelemetry, Sentry (self-hosted / EU) | |

### 3.3 Repository-Struktur

```
openplancraft/
├─ apps/
│  ├─ api/            # Fastify-Server (HTTP)
│  ├─ worker/         # BullMQ-Worker (PDF, E-Rechnung, Mail, Export)
│  └─ web/            # React-PWA
├─ packages/
│  ├─ domain/         # Reine Geschäftslogik: Kalkulation, Aufmaß-Formelparser, Mengenfortschreibung, Steuern, Summen, Nummern-Formate (keine I/O)
│  ├─ schemas/        # Zod-Schemas + Typen (API-Verträge)
│  ├─ db/             # Drizzle-Schema, Migrationen, RLS/Trigger-SQL, Seeds
│  ├─ einvoice/       # Mapping Dokument → EN16931, ZUGFeRD/XRechnung, Validierung
│  ├─ exports/        # DATEV-EXTF, GoBD-Z3 (index.xml), Gesamtexport
│  ├─ pdf-templates/  # HTML/CSS-Vorlagen für Dokumente und Bautagebuch
│  └─ ui/             # Designsystem-Komponenten
├─ infra/             # docker-compose, Caddyfile, Backup-Skripte
├─ docs/              # Recherche, ADRs, Verfahrensdokumentation
├─ CLAUDE.md
└─ DESIGN.md
```

### 3.4 Mandantenfähigkeit
- Ein Mandant = eine Firma (`tenant`). Jede fachliche Tabelle hat `tenant_id NOT NULL`.
- **Postgres Row Level Security**: Policy `tenant_id = current_setting('app.tenant_id')::uuid`. Die API setzt `SET LOCAL app.tenant_id` pro Transaktion. Der App-DB-User ist **nicht** Owner der Tabellen und hat kein `BYPASSRLS`.
- Zusätzliche Prüfung im Repository-Layer („Defense in Depth“). Integrationstests prüfen ausdrücklich, dass Mandanten sich nicht gegenseitig sehen.

---

## 4. Datenmodell (Kern)

IDs: UUIDv7. Zeitstempel: `timestamptz` (UTC); Belegdatum ist ein `date`. Beträge: `*_cents bigint`. Mengen: `numeric(18,4)`. Prozentsätze: `numeric(7,4)`.

```
tenant ─┬─ user (membership: role)
        ├─ number_sequence (type, year, prefix, next_value)
        ├─ customer ─┬─ customer_address
        │            └─ contact_person
        ├─ project ──┬─ document (quote | order_confirmation | change_order | invoice | credit_note | delivery_note)
        │            │    ├─ document_item (tree: parent_id, position_type, oz)
        │            │    │     ├─ item_calc_component (labor | material | equipment | subcontract)
        │            │    │     └─ invoice_item_quantity (cumulative_qty, previously_billed_qty) [nur Rechnungen]
        │            │    ├─ document_tax_line
        │            │    └─ document_artifact (pdf | zugferd_pdf | xrechnung_xml, sha256, s3_key, locked_until)
        │            ├─ measurement_sheet (kind: survey | performance, status, signed_by)
        │            │    ├─ measurement_location (tree: building / floor / room)
        │            │    └─ measurement_line (formula, variables, result_qty, unit,
        │            │                         document_item_id, location_id, photo, locked_by_invoice_id)
        │            ├─ change_order_meta (document_id, contract_document_id, number, basis, reason,
        │            │                     evidence → diary_entry / file / measurement_line)
        │            ├─ payment (invoice_id, amount_cents, date, method)
        │            ├─ diary_entry ─┬─ diary_attendance
        │            │               ├─ diary_photo → file
        │            │               └─ diary_signature
        │            └─ file
        ├─ catalog_item (service | article) ─ catalog_component
        ├─ text_template, document_template, tax_rate, payment_term
        ├─ export_job
        └─ audit_event (append-only, hash chain)
```

### 4.1 Dokumente und Lebenszyklus

```
           ┌──────────┐ finalize ┌─────────────────┐  pay   ┌─────────┐
 Angebot:  │  draft   │─────────▶│ sent / accepted │        │         │
           └──────────┘          │ / rejected      │        │         │
                                 └─────────────────┘        │         │
           ┌──────────┐ finalize ┌──────────────┐ payments  │  paid   │
 Rechnung: │  draft   │─────────▶│  finalized   │──────────▶│         │
           └──────────┘ (Nummer, └──────┬───────┘           └─────────┘
            frei editierbar,             │ correct / cancel
            löschbar)                    ▼
                                 Storno-Rechnung (eigene Nummer, negiert)
                                 + optional neue Rechnung (Kopie als Entwurf)
```

- **Entwurf**: frei editierbar und löschbar, hat noch **keine** Rechnungsnummer.
- **Festschreiben** (eine DB-Transaktion): Nummer aus `number_sequence` ziehen (`SELECT … FOR UPDATE`, lückenlos), Kunden- und Firmendaten als **Snapshot** in das Dokument kopieren, Summen final berechnen und speichern, Status `finalized`, `finalized_at`, `content_hash` (SHA-256 über kanonisches JSON). Danach Job: PDF/A-3 + XML erzeugen, validieren, in WORM-Bucket ablegen, Hash speichern.
- **DB-Trigger** verhindern `UPDATE`/`DELETE` an festgeschriebenen Dokumenten und deren Positionen (Ausnahme: Statusfelder wie `paid_status`, `sent_at`, über eine explizite Whitelist).
- **Angebote** sind nicht buchungsrelevant, werden aber beim Versand ebenfalls versioniert (Version n bleibt erhalten).
- **Abschlagsrechnungen**: kumulierter Leistungsstand oder Prozent/Betrag; die Schlussrechnung führt alle Abschläge mit Netto, USt und Brutto auf und zieht sie ab (§ 14 Abs. 5 UStG).
- **Steuerfälle** je Dokument: `standard` (19/7 %), `reverse_charge_13b` (0 %, Pflichttext „Steuerschuldnerschaft des Leistungsempfängers“), `small_business_19` (Kleinunternehmer), `intra_eu`, `export`. Mapping auf EN16931-Kategorien (S, AE, E, K, G).
- **Privatkunde + Leistung am Grundstück**: Pflichthinweis auf 2 Jahre Aufbewahrung, Lohnanteil nach § 35a ausweisen.

### 4.2 Kalkulation (packages/domain)
Je Position:
```
Lohn       = Σ (Zeit_h × Stundenverrechnungssatz)            [je Lohngruppe]
Material   = Σ (Menge × EK × (1 + Materialaufschlag))
Gerät      = Σ (Zeit × Gerätesatz)
Fremdleist.= Σ (EK × (1 + Fremdleistungsaufschlag))
EP         = (Lohn + Material + Gerät + Fremdleistung) × (1 + Wagnis/Gewinn), gerundet auf Cent
GP         = round(Menge × EP)
```
- Alternativ- und Bedarfspositionen erscheinen im PDF, zählen aber nicht zur Summe.
- Rundung: kaufmännisch (half-up) auf Cent je Position; USt je Steuersatz auf der Summe (EN16931-konform).
- Alle Formeln sind reine Funktionen mit 100 % Testabdeckung und Referenzfällen.

### 4.3 Aufmaß

**Zweck**: Das Aufmaß ist die Mengengrundlage für Angebot (Angebotsaufmaß), Abrechnung (Leistungsaufmaß) und Nachträge (Mehrmengen, Zusatzleistungen). Es ist abrechnungsrelevant und damit Teil der Nachweiskette einer Rechnung.

**Struktur**
- `measurement_sheet`: gehört zu einem Projekt, Art `survey` (vor Angebot) oder `performance` (ausgeführte Leistung), Status `draft` → `signed` (gemeinsames Aufmaß, Unterschrift beider Seiten mit Zeitstempel) .
- `measurement_location`: frei verschachtelbar (Haus A › EG › Bad), Räume mit optionalen Grunddaten (Länge, Breite, Höhe) als **Variablen** (`L`, `B`, `H`), die in Zeilen verwendet werden können.
- `measurement_line`: `formula` (Text, wie eingegeben), `variables` (jsonb), `result_qty numeric(18,4)` (serverseitig neu berechnet und gespeichert), `unit`, `is_deduction`, `document_item_id` (LV-Position aus Angebot/Auftrag/Nachtrag; darf vorübergehend leer sein = „nicht zugeordnet“), `note`, `photo_file_id`.

**Formelsprache** (`packages/domain/measurement`)
- Deutsches Zahlenformat (`4,25`), Operatoren `+ - * / ( )`, Potenz `^`, Funktionen `pi`, `sqrt`, `round`, Variablen aus dem Raum, Zeilenverweise optional später.
- **Eigener Parser (Tokenizer + Pratt-Parser), niemals `eval`/`Function`.** Gleiche Implementierung im Browser (offline, Live-Ergebnis) und auf dem Server (maßgebliche Berechnung).
- Vorlagen erzeugen Formeln: Rechteck `L*B`, Wandfläche `2*(L+B)*H`, Dreieck `g*h/2`, Kreis `pi*r^2`, Volumen `L*B*H`, Laufmeter, Stück.
- Abzugsregeln (z. B. Öffnungen < 2,5 m² nach VOB/C nicht abziehen) als **optionale, gewerkspezifische Hinweise**, nicht als harte Automatik – der Nutzer entscheidet.

**Mengenfluss**
```
Angebotsaufmaß ──Σ je Position──▶ Menge im Angebot ──▶ AB (Hauptauftrag)
Leistungsaufmaß ─Σ je Position──▶ kumulierte Ist-Menge
       Abschlags-/Schlussrechnung: abzurechnen = kumulierte Ist-Menge − bereits abgerechnete Menge
       Ist-Menge > LV-Menge  ──▶ Hinweis Mehrmenge (ab +10 %: Preisanpassung prüfen)
                              ──▶ 1 Klick „Nachtrag anlegen“ für Positionen ohne LV-Grundlage
```
- Beim Festschreiben einer Rechnung werden die verwendeten Aufmaßzeilen mit `locked_by_invoice_id` **gesperrt** und als PDF-Anlage (Aufmaßblatt) mit archiviert. Korrekturen danach nur über neue Zeilen (Korrekturzeile mit Verweis) bzw. Storno der Rechnung – gleiche Logik wie GoBD bei Belegen.
- Unterschriebene Aufmaßblätter sind gesperrt; Nachträge am Aufmaß erfolgen als neues Blatt mit Verweis.

### 4.4 Nachträge

- Ein Nachtrag ist ein `document` vom Typ `change_order` plus `change_order_meta`:
  - `contract_document_id` → Auftragsbestätigung des Hauptauftrags
  - `number` (je Projekt fortlaufend: N01, N02 …), OZ-Präfix im LV (`N01.0010`)
  - `basis`: `changed_work` (VOB/B § 2 Abs. 5), `additional_work` (§ 2 Abs. 6), `quantity_variance` (§ 2 Abs. 3), `bgb_650b` (Anordnung nach BGB), `other`
  - `reason` (Freitext), `evidence` (Verweise auf Bautagebuch-Einträge, Fotos, Aufmaßzeilen, Behinderungsanzeigen)
  - Status: `draft` → `offered` → `accepted` | `partially_accepted` | `rejected`; Beauftragung mit Datum, Name, optional Unterschrift/Dokument des Auftraggebers
- **Vertragssumme** eines Projekts = Hauptauftrag + Σ beauftragte Nachtragspositionen. Dashboard und Projektübersicht zeigen: Auftragssumme, Nachträge offen/beauftragt/abgelehnt, abgerechnet, noch abzurechnen.
- Rechnungen dürfen nur Positionen aus Hauptauftrag und **beauftragten** Nachträgen enthalten (plus freie Positionen mit Warnhinweis). Die Schlussrechnung gliedert nach Hauptauftrag und Nachträgen.
- Kalkulation von Nachträgen wie beim Angebot; Positionen aus dem Hauptauftrag können als Basis kopiert werden (Phase 2: Preisfortschreibung aus Urkalkulation).
- Angebotene Nachträge werden wie Angebote beim Versand versioniert und bleiben unveränderlich.

### 4.5 Bautagebuch
- `diary_entry` (project_id, date, weather jsonb, temperature, work_description, incidents, materials, equipment, status: draft|signed).
- Nach der Unterschrift ist der Eintrag gesperrt (Nachträge als verknüpfter Zusatzeintrag), weil das Bautagebuch Beweisfunktion hat (Behinderungsanzeigen, VOB/B § 6).
- Fotos: Original unverändert gespeichert (EXIF/GPS optional behalten, Hinweis Datenschutz), plus Thumbnails. Clientseitige Komprimierung optional abschaltbar.
- Wetter: Vorbefüllung über eine Wetter-API anhand der Baustellenkoordinaten (z. B. Open-Meteo/DWD), manuell überschreibbar.
- Aus einem Eintrag heraus: „Zusatzleistung / Behinderung erkannt“ → Nachtragsentwurf mit verknüpftem Eintrag und Fotos als Nachweis.

### 4.6 Audit-Log
`audit_event(id, tenant_id, actor_user_id, action, entity, entity_id, before jsonb, after jsonb, ip, user_agent, created_at, prev_hash, hash)`.
- **Append-only**: Der App-User hat auf dieser Tabelle nur `INSERT`/`SELECT`; Trigger blockiert `UPDATE`/`DELETE`.
- **Hash-Kette** je Mandant (`hash = sha256(prev_hash || canonical(event))`) macht Manipulation erkennbar. Ein nächtlicher Job prüft die Kette.
- Protokolliert werden alle Änderungen an steuerrelevanten Daten, Logins, Rechteänderungen und Exporte.

---

## 5. Datenhaltung, Sicherheit und Compliance

### 5.1 Sichere Speicherung
- **Hosting ausschließlich EU/Deutschland**, Anbieter mit ISO 27001 und AVV.
- **Verschlüsselung**: TLS 1.2+ (HSTS), Verschlüsselung at rest (Volume + S3 SSE). Besonders sensible Felder (IBAN, API-Schlüssel) zusätzlich anwendungsseitig verschlüsselt (AES-256-GCM, Schlüssel im Secret-Store, rotierbar).
- **Backups**: pgBackRest, kontinuierliche WAL-Archivierung (Point-in-Time-Recovery), tägliche Vollsicherung, verschlüsselt, in zweiter Region/zweitem Anbieter, 35 Tage Retention; **monatlicher Restore-Test** (automatisiert).
- **Archiv**: festgeschriebene Belege als Originaldatei im Bucket mit **Object Lock Compliance-Modus**, Sperrfrist = Aufbewahrungsfrist (Standard 10 Jahre ab Ende des Kalenderjahres). Hash zusätzlich in der DB.

### 5.2 Anwendungssicherheit
- Passwörter: argon2id; Login-Rate-Limit; Sperre nach Fehlversuchen; Benachrichtigung bei neuem Gerät.
- 2FA (TOTP) für Rolle Inhaber verpflichtend, für alle anderen empfohlen.
- Sessions: serverseitig gespeichert, Cookie `HttpOnly; Secure; SameSite=Lax`, CSRF-Token bei zustandsändernden Requests, Session-Liste mit „überall abmelden“.
- **Rollen & Rechte (RBAC)**:

| Recht | Inhaber | Büro | Bauleiter | Monteur |
|---|:-:|:-:|:-:|:-:|
| Firma, Nutzer, Abrechnung | ✔ | – | – | – |
| Kunden | ✔ | ✔ | lesen | – |
| Angebote/Rechnungen | ✔ | ✔ | lesen (eigene Projekte) | – |
| Preise/Kalkulation sehen | ✔ | ✔ | optional | – |
| Projekte | ✔ | ✔ | ✔ (zugewiesen) | lesen (zugewiesen) |
| Bautagebuch | ✔ | ✔ | ✔ | erfassen (zugewiesen) |
| Exporte (DATEV/GoBD) | ✔ | ✔ | – | – |

- Eingaben mit Zod validiert, SQL nur parametrisiert (Drizzle), Ausgabe-Escaping in React und PDF-Templates, strikte **CSP**, Upload-Prüfung (MIME-Sniffing, Größenlimit, keine aktiven Inhalte), signierte, kurzlebige S3-URLs.
- Abhängigkeiten: Renovate, `pnpm audit`, CodeQL in CI; Secrets nie im Repo.

### 5.3 Finanzverwaltung und Steuerberater
| Anforderung | Umsetzung |
|---|---|
| Unveränderbarkeit | Festschreiben + DB-Trigger + WORM-Archiv + Hash; abrechnungsrelevante Aufmaßzeilen werden mit der Rechnung gesperrt und als Anlage archiviert |
| Nachvollziehbarkeit | Audit-Log mit Hash-Kette, Storno statt Löschen, Snapshots |
| Vollständigkeit | Lückenlose Nummernkreise; Lücken technisch unmöglich (Nummer erst beim Festschreiben) |
| Zeitgerechte Erfassung | `finalized_at`, Server-Zeitstempel |
| Maschinelle Auswertbarkeit / **Z3-Datenträgerüberlassung** | Export „Betriebsprüfung“: ZIP mit CSV-Dateien (Rechnungen, Positionen, Steuerzeilen, Zahlungen, Kunden, Audit-Log) + **`index.xml` nach GDPdU-Beschreibungsstandard (gdpdu-01-09-2004.dtd)**, Zeitraumfilter, plus Original-Belegdateien |
| Z1/Z2-Zugriff | Prüferrolle „Nur lesen“, zeitlich befristet, nur steuerrelevante Bereiche, jede Aktion protokolliert |
| Steuerberater | **DATEV-Buchungsstapel (EXTF, Format 700)** mit Erlöskonten nach SKR03/SKR04 (Mapping konfigurierbar), Debitorennummern, Belegfeld 1 = Rechnungsnummer; Belegbilder als ZIP; später DATEV-Connect-online-Anbindung |
| E-Rechnung | ZUGFeRD 2.x Profil EN 16931 (Standard) und XRechnung UBL (für öffentliche Auftraggeber mit Leitweg-ID); jede Datei wird vor dem Versand gegen KoSIT validiert, sonst blockiert der Versand mit einer verständlichen Meldung |
| Verfahrensdokumentation | Vorlage in `docs/verfahrensdokumentation/`, die Kunden übernehmen und ergänzen können |
| DSGVO | AVV-Vorlage, Löschkonzept: nicht steuerrelevante Daten löschbar; steuerrelevante werden bis Fristende **gesperrt** und danach automatisch gelöscht; Auskunfts- und Exportfunktion |

---

## 6. API-Design

- REST unter `/api/v1`, JSON, OpenAPI 3.1 aus Zod generiert; der Frontend-Client wird daraus typisiert.
- Ressourcen: `/customers`, `/projects`, `/projects/:id/measurement-sheets`, `/measurement-sheets/:id/lines`, `/measurement-sheets/:id/sign`, `/projects/:id/change-orders`, `/change-orders/:id/accept`, `/projects/:id/contract` (Vertragssumme, Soll/Ist je Position), `/projects/:id/documents`, `/documents/:id/items`, `/documents/:id/finalize`, `/documents/:id/cancel`, `/documents/:id/derive?type=invoice`, `/documents/:id/send`, `/invoices/:id/payments`, `/projects/:id/diary`, `/files` (Upload via vorsignierte URL), `/exports/datev`, `/exports/gobd`, `/exports/full`, `/catalog`, `/settings/*`, `/audit`.
- Paginierung per Cursor; Filter über Query-Parameter; `ETag`/`If-Match` für Optimistic Locking bei Entwürfen.
- **Idempotency-Key**-Header für alle POSTs (wichtig für Offline-Sync und Doppelklicks beim Festschreiben).
- Fehlerformat RFC 9457 (`application/problem+json`) mit nutzerfreundlichem deutschem `detail`.

### Offline-Sync (Baustellenmodule)
- Umfang offline: zugewiesene Projekte inkl. LV-Positionen (lesen), **Aufmaß (schreiben)**, Bautagebuch (schreiben), Fotos (aufnehmen), später Zeiterfassung.
- Client-Outbox in IndexedDB: Operationen mit clientseitig erzeugter UUIDv7 + Idempotency-Key; Background Sync bzw. Retry beim Online-Werden.
- Konflikte Aufmaß: Zeilen sind eigenständige Datensätze mit Client-UUID, daher praktisch konfliktfrei (paralleles Erfassen durch mehrere Personen möglich); gesperrte Blätter/Zeilen werden beim Sync abgewiesen und als Korrekturzeile angeboten.
- Konflikte Bautagebuch: Einträge gehören einem Autor und Tag; bei Konflikt „last writer wins“ pro Feld mit Hinweis. Festgeschriebene Finanzdokumente sind nie offline editierbar.

---

## 7. Frontend- und UX-Design

### 7.1 Responsive-Strategie (alle Geräte)
| Breakpoint | Gerät | Layout |
|---|---|---|
| < 640 px | Smartphone | Bottom-Navigation (5 Punkte: Start, Projekte, **+**, Bautagebuch, Mehr), Listen als Karten, Vollbild-Formulare, Positions-Editor als Akkordeon |
| 640–1024 px | Tablet (Baustelle, Aufmaß) | Einklappbare Seitenleiste, zweispaltig (Liste + Detail) |
| > 1024 px | Desktop (Büro) | Seitenleiste, Tabellen, Angebots-Editor mit Live-PDF-Vorschau rechts |

- Getestet in CI mit Playwright auf iPhone SE, iPhone 15, Pixel 7, iPad und Desktop 1440 px. Zielbrowser: die letzten 2 Versionen von Safari (iOS ≥ 16), Chrome, Edge, Firefox, Samsung Internet.
- Installierbar als PWA (Manifest, Icons, Splash) inkl. Kamerazugriff für Fotos.
- Performance-Budget: initial JS < 200 kB gzip, LCP < 2,5 s auf 4G, Interaktion < 100 ms. Routen-basiertes Code-Splitting; der Angebotseditor lädt nach.

### 7.2 Visuelles Designsystem (eigenständig)
- **Charakter**: robust, klar, vertrauenswürdig – „gutes Werkzeug“ statt verspielter Start-up-Optik.
- **Farben** (Tokens, Light/Dark):
  - `--color-primary`: Tiefes Petrol `#0F4C5C` (Vertrauen, Ruhe)
  - `--color-accent`: Signal-Orange `#F28C28` (Baustelle, Handlungsaufforderung – sparsam einsetzen)
  - Neutrale Töne: Schiefer-Grau-Skala `#0F172A … #F8FAFC`
  - Status: Erfolg `#15803D`, Warnung `#B45309`, Fehler `#B91C1C`, Info `#1D4ED8`
  - Kontrast mindestens WCAG 2.2 AA (Text 4,5:1), im Baustellenmodus optional „Hoher Kontrast“ für Sonnenlicht
- **Typografie**: `Inter` (UI, mit Tabellenziffern `font-variant-numeric: tabular-nums` für Beträge), Basis 16 px (mobil nie kleiner), Skala 12/14/16/18/20/24/30/36.
- **Abstände**: 4-px-Raster; Touch-Ziele **mindestens 44 × 44 px**, auf Baustellen-Screens 56 px.
- **Komponenten**: Button (primary/secondary/ghost/destructive), Input mit Einheit (m², Std., Stk.), Geldfeld (deutsches Format `1.234,56 €`), Status-Badge, Datenkarte, Tabelle mit Sticky Header, Bottom Sheet (mobil), Dialog, Toast, Leerzustand mit Handlungsaufforderung, Stepper für Onboarding, Signaturfeld, Kamera-/Foto-Grid.
- **Icons**: Lucide (Open Source), einheitlich 1,5 px Strich.
- **Sprache**: Deutsch (de-DE), i18n-fähig (Österreich, später EN/PL/TR/RU für Monteure). Zahlen, Datum und Währung über `Intl`.

### 7.3 Zentrale Screens
1. **Onboarding (≤ 10 min)**: Firmendaten → Logo/Briefpapier → Steuerdaten → Nummernkreise (sinnvolle Vorgaben) → Gewerk wählen → Beispiel-Leistungskatalog laden → erstes Angebot.
2. **Dashboard**: „Heute“ (Baustellen, fällige Rechnungen), Kennzahlen, Schnellaktionen.
3. **Projekt-Detail**: Kopf (Kunde, Adresse mit Kartenlink, Status), Tabs: Übersicht · Dokumente · Bautagebuch · Fotos · Dateien · Zahlungen.
4. **Angebots-Editor**: links LV-Baum (Drag & Drop), Mitte Positionen mit Inline-Bearbeitung, Suche im Leistungsstamm (`/`-Shortcut), rechts Kalkulationsdetails bzw. Live-Vorschau; Summen-Leiste fixiert unten; Autosave.
5. **Aufmaß (Tablet/Phone)**: oben Raum-Navigation (Haus › Geschoss › Raum), darunter Zeilenliste; Eingabe über eigene **Zahlen-/Formel-Tastatur** (große Tasten, `×`, `−`, Klammern, Komma) mit Live-Ergebnis; Positions-Auswahl per Suche oder „zuletzt verwendet“; Vorlagen-Chips (Rechteck, Wand, Abzug Tür/Fenster); Summe je Position und Abweichung zur LV-Menge farbig; Foto/Skizze je Zeile; Unterschrift für gemeinsames Aufmaß.
6. **Nachträge**: Liste je Projekt mit Status-Badges und Summen; Editor wie Angebot, zusätzlich Grund, Rechtsgrundlage und Nachweis-Picker (Tagebuch, Fotos, Aufmaß); Leiste „Vertragssumme: Hauptauftrag + Nachträge“.
7. **Rechnung aus Auftrag**: Assistent „Abschlag / Schluss“: Mengen aus Leistungsaufmaß übernehmen, Positionen aus Hauptauftrag und beauftragten Nachträgen, Vorschau der Anrechnungen und Mehr-/Mindermengen.
8. **Bautagebuch mobil**: Ein Bildschirm, ein Daumen: Datum (heute), Wetter vorbefüllt, Chips für Anwesende, Textfeld mit Diktierfunktion des Geräts, Foto-Button groß, „Speichern“ funktioniert offline (Sync-Indikator), Aktion „Nachtrag anlegen“.
9. **Export-Center**: Zeitraum wählen → DATEV / Betriebsprüfung (Z3) / Komplett-Export, mit Erklärungstext.

### 7.4 UX-Regeln für Compliance
- Vor dem Festschreiben: Bestätigungsdialog „Nach dem Festschreiben kann die Rechnung nicht mehr geändert werden. Korrekturen erfolgen über eine Stornorechnung.“
- Button „Rechnung korrigieren“ erzeugt in einem Schritt Storno + neuen Entwurf und erklärt das.
- Pflichtangaben-Check (§ 14 Abs. 4 UStG) vor dem Festschreiben mit konkreten Hinweisen (z. B. „Leistungsdatum fehlt“).

---

## 8. Qualität, Tests, Betrieb

- **Tests**: Domain-Logik (Kalkulation, Aufmaß-Formelparser inkl. Fuzzing und Fehlerfällen, Mengenfortschreibung, Nachtragssummen, Steuern, Rundung, Abschlagsanrechnung) mit Referenzbeispielen; DB-Tests für RLS, Trigger, Nummernkreise unter Parallelität; E-Rechnungen durch den KoSIT-Validator in CI; E2E-Kernflüsse (Aufmaß → Angebot → AB → Nachtrag → Abschlag aus Leistungsaufmaß → Schlussrechnung → Export, Aufmaß/Bautagebuch offline → Sync) auf Mobil und Desktop.
- **CI** (GitHub Actions): lint, typecheck, unit, integration (Testcontainers), e2e, build, Security-Scans.
- **Umgebungen**: dev (Docker Compose), staging, production; Migrationen vorwärtskompatibel (expand/contract).
- **Monitoring**: Uptime, Fehlerquote, Job-Queue-Länge, nächtliche Audit-Kettenprüfung, Backup-Restore-Test.
- **ADRs** in `docs/adr/` für jede größere Entscheidung.

---

## 9. Offene Fragen
1. Hosting-Anbieter (Hetzner vs. IONOS vs. STACKIT) und ob Selbst-Hosting durch Kunden angeboten werden soll.
2. Preis- und Tarifmodell (bestimmt Feature-Flags je Plan).
3. Österreich bereits im MVP oder erst in Phase 2?
4. Formale GoBD-Testierung (IDW PS 880) anstreben?
5. Die Anforderung „…für die Finanzverwaltung so gespeichert, dass man Daten …“ war im Auftrag abgeschnitten. Angenommen wurde: **jederzeit vollständig und maschinell auswertbar exportieren kann** (Z3/DATEV, siehe 5.3). Bitte bestätigen oder ergänzen.
