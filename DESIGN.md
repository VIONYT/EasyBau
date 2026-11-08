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
| **Konto & Firma** | Registrierung mit E-Mail-Bestätigung, Firmendaten (Name mit Rechtsform, Anschrift, **Gewerk**, Kontakt, Logo), Rechtliches (verantwortliche Person + Funktion, USt-IdNr., Steuernummer, Amtsgericht, Handelsregisternummer), Bankverbindung, Arbeitszeiten, Feiertage nach Bundesland, Nummernkreise, Steuersätze, Zahlungsziel & Skonto, Lohnkostenanteil-Ausweis, Bezahlcode, Abschlagsregeln, Briefpapier, Anfangs-/Schlusstexte, automatische Anhänge, Dateinamen-Muster, E-Mail-Versand, Lohngruppen, Zuschläge, Einheiten, Nutzer & Rollen, 2FA (Struktur siehe §7.4) |
| **Kontakte (CRM)** | Typ Person oder Organisation; Personen lassen sich mit Organisationen verknüpfen (Ansprechpartner); Kundennummer (K-…); mehrere E-Mails/Telefonnummern mit Label (Arbeit, Mobil, Privat); Website; Farbmarkierung; Beschreibung; Adresse mit Kartenlink; **abweichender Rechnungsempfänger** (Empfängerblock); kundenspezifisch: Zahlungsziel & Skonto, Steuerfall/Steuersatz (inkl. § 13b-Kennzeichen), **XRechnung-Daten** (Leitweg-ID, E-Mail für E-Rechnungen, bevorzugtes Format); Projekte des Kontakts; Liste mit Suche, Filter (Typ, Farbe), CSV-Import/-Export |
| **Projekte** | Anlage mit Projektname (Pflicht), Beschreibung, Projektnummer (automatisch P-…, manuell überschreibbar, eindeutig je Mandant), Status (darf leer sein), Mitarbeitende (Ersteller vorausgewählt), Kunde aus Kontakten (oder direkt neu anlegen), Baustellenadresse = **Leistungsort** (Straße, Zusatz, PLZ, Ort, Land; Vorschlag aus Kundenadresse); **Zeitraum** (Start/Ende, Grundlage für spätere Plantafel), zugeordnete Mitarbeitende, Status als Pipeline inkl. Vertrieb (Erstkontakt → Besichtigung/Aufmaß → Angebot → Auftrag → In Ausführung → Abgerechnet → Abgeschlossen; Status direkt in Liste und Kopf änderbar; je Mandant anpassbar), Archivieren; Bereiche Dokumente · Berichte · Aufmaß · Ablage (Dateien/Fotos) · Zahlungen; Kennzahlen Soll-Stunden aus Kalkulation, Auftragssumme, abgerechnet, offen; Projektliste mit Suche, Filter (aktiv/archiviert, Zeitraum, Status, Mitarbeitende) |
| **Stammdaten (Leistungen & Materialien)** | Zwei Listen: **Leistungen** (Kurz- und Langtext, Einheit, Kosten aus Kalkulation, Zuschlag %, VK; Bestandteile Lohn/Material/Gerät/Fremdleistung/Sonstiges) und **Materialien** (Artikelnummer, Hersteller, Kurz-/Langtext, Einheit, EK, Zuschlag %, VK, Gebindeinhalt); Ordner/Kategorien, Suche, Mehrfachauswahl, CSV/Excel-Import und -Export; Gewerks-Startkatalog beim Onboarding; Positionen aus einem Angebot „in Stammdaten speichern“; Anlage im Seitenpanel (Ordner, Einheit, Kurztext, optional Langtext, Bild, Kosten/Zuschlag → VK oder ausführliche Preiskalkulation); Ordner optional (Standardordner „Allgemein“) |
| **Angebot / Kostenvoranschlag / Kalkulation** | Dokumenttypen Angebot und **Kostenvoranschlag** (unverbindlich, § 649 BGB, eigener Nummernkreis KV-…); Kopf mit Empfänger, Ansprechperson, Datum, Betreff, **Leistungsort**; Anfangs- und Schlusstext aus Vorlagen; Hierarchisches LV (Titel/Untertitel/Positionen, OZ automatisch), Positionstypen (Normal, Alternativ, Bedarf/Eventual, Pauschal, Text, Zwischensumme), Kalkulation je Position (Zeit × Stundenverrechnungssatz + Material EK × Aufschlag + Gerät + Fremdleistung) im Modus Einheitspreis oder Gesamtpreis, **Aufmaß direkt in der Position**, Kurz- und Langtext (Langtext ein-/ausblendbar), Bilder als Positionstyp, globale Zuschläge, Rabatt je Position und gesamt, **Zielpreis („Preis anpassen“)**, Dokument-Fuß mit Summen (netto, USt je Satz, brutto), Umsatzsteuer je Dokument (Land + Satz bzw. Steuerfall), Lohnkostenanteil ein/aus, Zahlungsziel & Skonto (Vorgabe aus Kontakt/Einstellungen, je Dokument änderbar), Lohnanteil-Ausweis § 35a, Vorlagen, PDF-Vorschau live, Versand per E-Mail, Versionen |
| **Aufmaß** ⭐ | Aufmaßblätter je Projekt, gegliedert nach Gebäude/Geschoss/Raum; Zeilen mit **Formeln** (z. B. `4,25*2,60 - 0,885*2,01`), Variablen, Abzügen (Öffnungen), Formelvorlagen (Rechteck, Wandfläche aus Raumumfang × Höhe, Dreieck, Kreis, Volumen, Stück); Zuordnung jeder Zeile zu einer LV-Position; Skizze/Foto je Zeile; zwei Arten: **Angebotsaufmaß** (Mengen → Angebot) und **Leistungsaufmaß** (ausgeführte Mengen → Abschlags-/Schlussrechnung); gemeinsames Aufmaß mit Unterschrift des Auftraggebers; Mehr-/Mindermengen gegenüber LV mit Hinweis ab ±10 % (VOB/B § 2 Abs. 3); PDF-Aufmaßblatt als Rechnungsanlage; **offline auf dem Tablet** |
| **Auftragsbestätigung** | 1-Klick aus Angebot; begründet den **Hauptauftrag** (Vertragssumme) |
| **Nachträge** ⭐ | Nachtragsangebote zum Hauptauftrag (N01, N02 …) mit eigenem LV (OZ `N01.0010`), Grund und Rechtsgrundlage (geänderte Leistung VOB/B § 2 Abs. 5, zusätzliche Leistung § 2 Abs. 6, BGB § 650b/c), Verknüpfung zu Bautagebuch-Einträgen, Fotos und Aufmaß als Nachweis; Status Entwurf → angeboten → beauftragt / teilbeauftragt / abgelehnt; Anlegen direkt aus Bautagebuch („Zusatzleistung erkannt“) oder aus Aufmaß-Mehrmengen; beauftragte Nachträge erhöhen die Vertragssumme und sind in Abschlags-/Schlussrechnungen abrechenbar; Übersicht offene/beauftragte Nachträge je Projekt |
| **Rechnungen** | Abschlags-, Teil-, Schluss- und Einzelrechnung, **Mengen aus dem Leistungsaufmaß** (kumuliert, bereits abgerechnete Mengen werden abgezogen), Positionen aus Hauptauftrag **und** beauftragten Nachträgen, Anrechnung vorheriger Abschläge (Abschläge **kumulativ** – Gesamtleistungsstand abzüglich bisheriger Abschläge – oder **einzeln**; Standard in den Einstellungen wählbar), Sicherheitseinbehalt und **Bauumlage** (prozentuale Abzüge im Dokument-Fuß, z. B. 5 % Einbehalt, 0,5 % Bauumlage), Skonto (Prozent + Tage) und Zahlungsziel (Tage → Datum im Text), § 13b-Text, Storno mit Pflicht-Grund und Option „neu ausstellen“ (Kopie als Entwurf), **ZUGFeRD 2.x (EN 16931) als PDF/A-3 + XRechnung (UBL)**, E-Mail-Versand |
| **Rechnungsliste** | Filter Zeitraum, Status (Entwurf, offen, teilbezahlt, bezahlt, überfällig, angemahnt, storniert), Art (Rechnung, Abschlag, Schluss, Gutschrift, Storno), Projekt, „mit Sicherheitseinbehalt“; Umschalter netto/brutto; Spalten Nr., Titel + Art, Empfänger, Status, Fälligkeit, Betrag, offen; Summenzeile (Betrag, offen, bezahlt); Zeilenmenü PDF ansehen/herunterladen, E-Rechnung herunterladen, Projekt öffnen, Kürzen, Stornieren; CSV-Export |
| **Zusammenhängend erstellen** | Aus jedem Dokument heraus Folgedokumente anlegen: aus Angebot → AB, Nachtrag, Abschlag, Rechnung; aus Abschlag → nächster Abschlag, Schlussrechnung, Lieferschein, Zahlungserinnerung. Positionsauswahl mit „Alle auswählen“, Optionen „Mengen übernehmen“ (oder aus Leistungsaufmaß) und „Anfangs-/Schlusstexte inkl. Bilder übernehmen“ |
| **Zahlungen & Forderungen** | Rechnungsdetail mit Status und **offener Forderung** (= brutto − Zahlungen − Abzüge − Kürzungen); Zahlungen erfassen (Datum, Betrag, Weg; Teilzahlungen); **Abzüge** (gezogenes Skonto, Sicherheitseinbehalt, Bankgebühr, sonstiger Abzug mit Grund); **Kürzung** durch den Auftraggeber (Betrag + Begründung, bleibt streitig markierbar; ändert die Rechnung nicht, sondern die Forderung); Notizen; Liste „zusammenhängende Dokumente“; **Bezahlcode (EPC-QR / GiroCode)** mit Firmenname, IBAN, Betrag (ohne Skonto) und Rechnungsnummer als Verwendungszweck |
| **Mahnwesen** | Aus der Rechnung „zusammenhängend erstellen“: Zahlungserinnerung → 1. Mahnung → 2. Mahnung (letzte), Stufen nur nacheinander; je Stufe Frist (Tage), Verzugszinsen %, Mahngebühr € (Vorgaben in den Einstellungen); Schreiben mit Bezug auf Rechnung und Leistungsort, Aufstellung der fälligen Beträge und Zahlungsfrist; Versand per E-Mail oder PDF; Status „angemahnt“; Hinweise: Verzugszinsen automatisch tagesgenau (Basiszinssatz + 5 bzw. 9 Prozentpunkte nach § 288 BGB, Basiszinssatz als gepflegte Tabelle), Verzugspauschale 40 € bei Geschäftskunden optional, Mahngebühren und Zinsen ohne USt |
| **Bautagebuch & Berichte** | Berichte aus **Vorlagen** (siehe §4.5): Bautagesbericht, Regiebericht, Abnahmeprotokoll, Bedenkenanzeige (VOB/B § 4 Abs. 3), Behinderungsanzeige (VOB/B § 6 Abs. 1), Baustellenbegehung, Besprechungsprotokoll, Checkliste, Einsatzbericht; **abrechenbare** Berichte (Regie, Einsatz) übernehmen Stunden/Material in Rechnungen. Bautagesbericht: Tageseintrag je Projekt: Datum, Wetter (automatisch vorbefüllt), Temperatur, Anwesende (Personen/Kolonnen, Stunden), ausgeführte Arbeiten, Material/Geräte, Besonderheiten/Behinderungen/Mängel, Fotos mit Bildunterschrift, Unterschrift Bauleiter/Auftraggeber, PDF-Export; **offline erfassbar** |
| **Export & Archiv** | DATEV-Buchungsstapel (EXTF CSV) + Belege, GoBD-Datenträgerüberlassung (Z3, CSV + `index.xml`), vollständiger Datenexport (ZIP), revisionssicheres Belegarchiv |
| **Dashboard** | Offene Forderungen (Summe brutto, aufgeteilt in offen/überfällig/angemahnt mit Anzahl, Beträge per Klick ausblendbar), zuletzt bearbeitete Projekte mit Status, offene Angebote und Nachträge, heutige Baustellen, Wetter am Firmen- bzw. Baustellenort (Stundenvorschau) |
| **Suche & Benachrichtigungen** | Globale Suche über Kontakte, Projekte, Dokumente, Stammdaten; Benachrichtigungen (z. B. Rechnung überfällig, Nachtrag beauftragt, Bericht unterschrieben) |

### Phase 2 – Wachstum
Zeiterfassung (Stempeluhr mobil, je Projekt) · Aufmaß-Austausch (REB 23.003 / GAEB X31, Import aus Laser-Messgeräten/Apps) · Nachtragskalkulation auf Basis der Urkalkulation (Preisfortschreibung) · Mahnbescheid-Export (Online-Mahnantrag) · DATANORM 4/5-Import · GAEB DA XML (X83 Import, X84 Export) · **Eingangsrechnungen** (Upload per Drag & Drop: PDF, XML, JPG, PNG; E-Rechnungen lesbar darstellen; Liste mit Lieferant, Nr., Datum, Netto, Kostenzuweisung, Zahlstatus; Bereich „Zu prüfen“; Filter Zeitraum/Zuweisung/Zahlstatus; Zuweisung auf Projekt **oder Betriebsbereich** (Vorgaben: Lager, Büro, Mitarbeitende, Fahrzeuge, Werkstatt, Sonstiges; je Mandant erweiterbar) und Kostenart (Material, Lohn, Geräte, Fremdleistung, Sonstiges) mit Beschreibung; Erkennung von § 13b bei Eingangsrechnungen (0 % USt mit Hinweis auf Steuerschuldnerschaft) → Kennzeichen für Umsatzsteuer-Voranmeldung und DATEV-Export; GoBD-Archiv; Detailansicht mit Belegvorschau links und Rechnungsdaten rechts (Lieferant, Nummer, Datum, Netto, Zahlstatus), **Kostenzuweisung** aufteilbar auf mehrere Projekte/Kostenarten mit Restbetrag-Anzeige oder je Rechnungsposition; „Prüfung bestätigen“ schließt die Prüfung ab; Löschen nur vor der Bestätigung, danach nur Stornieren/Ausbuchen; KI-Auslesen der Rechnungsdaten in Phase 3, bei E-Rechnungen direkt aus dem XML) · **Nachkalkulation** (Soll aus der Kalkulation ausgewählter Dokumente vs. Ist aus Zeiten, Eingangsrechnungen und manuell erfassten Kosten; je Kostenart; Positionen ohne Kalkulation werden mit VK angesetzt und gekennzeichnet) · **Plantafel** (Zeitleiste nach Kalenderwochen mit Projekten und Mitarbeitenden, Wochenenden/Feiertage markiert, Zoom, Projekt-Zeitraum per Ziehen ändern) · **Projekt-Chat** (Nachrichten, @-Erwähnungen, Fotogalerie je Projekt) · Kundenportal mit Online-Annahme und Signatur · Lieferscheine, Gutschriften · Österreich (USt-Sätze, ebInterface).

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
        ├─ number_sequence (type, prefix, start_value, min_length, next_value, reset_yearly)
        ├─ contact (kind: person | organization, number, color, description)
        │    ├─ contact_channel (email | phone | website, label)
        │    ├─ contact_address (kind: main | billing, recipient_block)
        │    ├─ contact_link (person ↔ organization, role)
        │    └─ contact_billing_settings (payment_term, tax_mode, buyer_reference, einvoice_email, einvoice_format)
        ├─ project ──┬─ document (quote | cost_estimate | order_confirmation | change_order | invoice | credit_note | delivery_note)
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
        │            ├─ report (template_id, date, status, billable) ─┬─ report_field_value
        │            │                                                 ├─ report_attendance / report_billable_line
        │            │                                                 ├─ report_photo → file
        │            │                                                 └─ report_signature
        │            ├─ project_member (user_id)
        │            └─ file (folder from filing template)
        ├─ catalog_item (service | material) ─ catalog_component · catalog_folder
        ├─ unit, wage_group, surcharge, tax_rate, payment_term
        ├─ report_template (fields schema, billable, active), text_template, letterhead,
        │  filing_template (Ablage-Ordner), auto_attachment, filename_pattern, email_template
        ├─ working_hours, holiday_calendar (federal_state)
        ├─ export_job
        └─ audit_event (append-only, hash chain)
```

### 4.1 Dokumente und Lebenszyklus

**Neues Dokument im Projekt** – Auswahldialog mit den im aktuellen Projektstand sinnvollen Typen:
Angebot · Kostenvoranschlag · Auftragsbestätigung · Nachtragsangebot (nur mit Hauptauftrag) · Lieferschein · Rechnung · *n.* Abschlagsrechnung (fortlaufend je Projekt gezählt: „1. Abschlagsrechnung“, „2. …“) · Schlussrechnung (sobald ein Auftrag oder Abschlag existiert) · Gutschrift.
- Jeder Typ kann leer oder **aus einem bestehenden Dokument** abgeleitet werden (Positionen, Texte, Kunde, Leistungsort werden übernommen; Verweis `source_document_id` bleibt erhalten).
- Im Projekt werden Dokumente nach Typ gruppiert (Angebote, Aufträge, Nachträge, Rechnungen …) mit Nummer, Datum, Ersteller und Status-Badges (Entwurf, versendet, beauftragt, bezahlt, überfällig …).

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
- **Schlussrechnung erstellen** (Ablauf):
  1. Dialog „Positionen übernehmen aus …“: zusammenhängende Dokumente (Abschlagsrechnungen) oben, darunter Angebote/Aufträge und **beauftragte** Nachträge (nicht beauftragte ausgegraut mit Hinweis), oder „Leer beginnen“. Mehrfachauswahl Hauptauftrag + Nachträge möglich; Mengen werden aus dem Leistungsaufmaß vorgeschlagen.
  2. Kopf: Empfänger (aus Kontakt, für dieses Dokument lösbar), Ansprechperson, Rechnungsdatum, **Leistungszeitraum von–bis** (Pflicht, Vorschlag aus Projektzeitraum/Berichten), Betreff, Leistungsort; Referenzzeile auf die angerechneten Abschläge.
  3. Positionen (gegliedert nach Hauptauftrag und Nachträgen), Summen.
  4. **Abschlagsaufstellung** – unsere Variante, steuerlich sauber:

     | Zeile | Netto | USt | Brutto |
     |---|---:|---:|---:|
     | Gesamtleistung | x | x | x |
     | − 1. Abschlagsrechnung R-… vom … | x | x | x |
     | − 2. Abschlagsrechnung … | x | x | x |
     | **= Restbetrag dieser Schlussrechnung** (Bemessungsgrundlage) | x | x | x |
     | − Zahlungen auf Abschläge / + noch offene Abschläge | | | x |
     | − Sicherheitseinbehalt (falls vereinbart) | | | x |
     | **= Zahlbetrag** | | | x |

     Abgezogen werden alle *gestellten* Abschlagsrechnungen mit ihren Steuerbeträgen. So wird keine Umsatzsteuer doppelt ausgewiesen, auch wenn ein Abschlag noch unbezahlt ist. Unbezahlte Abschläge bleiben als eigene offene Forderungen bestehen und werden im Zahlbetrag nur informativ mit aufgeführt. (Fachliche Freigabe mit einem Steuerberater vor Go-Live; siehe offene Fragen.)
  5. Schlusstexte aus Vorlagen: Hinweis, dass mit der Schlussrechnung abschließend abgerechnet wird; Zahlungsziel mit konkretem Datum; Pflichthinweis § 14 Abs. 4 Nr. 9 UStG (2 Jahre Aufbewahrung für Privatkunden, nur bei Privatkunden einfügen); bei Bedarf § 13b- oder § 35a-Text.
  6. Vorschau: Toolbar mit Vorschau, Download (als Entwurf gekennzeichnet), E-Mail, Einstellungen; Hauptaktion **„Festschreiben“** mit Pflichtangaben-Prüfung und Bestätigungsdialog. Erst dann werden Nummer, PDF/A-3 und E-Rechnung erzeugt.
- **Leistungsdatum**: Wir verlassen uns nicht auf den Standardsatz „Leistungsdatum = Rechnungsdatum“. Leistungsdatum bzw. -zeitraum ist ein Pflichtfeld mit Vorschlag und wird auch in die E-Rechnung (BT-72 bzw. BG-14) geschrieben.
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
- **Kostenzeilen je Position**: Art (Lohn, Material, Gerät, Fremdleistung, Sonstiges), Menge, Einheit (z. B. `min`, `Std`, `psch`, `kg`), Beschreibung, EK je Einheit, EK gesamt. Lohnzeilen beziehen den Satz aus einer **Lohngruppe** (z. B. Meister, Geselle, Helfer, Auszubildender 2. Lehrjahr: Kosten/Std + Zuschlag → Verrechnungssatz); bei Eingabe in Minuten wird der Satz pro Minute umgerechnet.
- **Modus Einheitspreis**: Kostenzeilen gelten pro 1 Einheit der Position (EP = Σ Kosten × Zuschläge; GP = Menge × EP). **Modus Gesamtpreis**: Kostenzeilen gelten für die ganze Positionsmenge (GP = Σ Kosten × Zuschläge; EP = GP / Menge, gerundet).
- **Zuschläge** (Einstellungen › Kalkulation): getrennt nach Kostenart (z. B. Material 20 %, Lohn über Lohngruppe, Gerät, Fremdleistung) plus optional Allgemeine Geschäftskosten / Wagnis & Gewinn; je Position überschreibbar. Angezeigt werden Kosten, Zuschlag % und VK.
- **Zielpreis („Preis anpassen“)**: Dialog mit Gesamtkosten, Gesamtzuschlag (% und €), editierbarer Netto- **oder** Bruttosumme, Schalter „auf alle Positionen umverteilen“ (sonst als eigene Ausgleichs-/Rabattzeile) und Anzeige der Differenz. Der Nutzer gibt eine gewünschte Summe ein. Die Differenz wird proportional auf die Zuschläge der kalkulierten Positionen verteilt (Kosten bleiben unverändert); Positionen ohne Kalkulation und Pauschalen bleiben fix, sofern nicht anders gewählt. Vorher/Nachher-Vorschau mit resultierender Marge; Warnung, wenn ein Zuschlag negativ würde (Verkauf unter Kosten). Rundungsdifferenzen landen in der größten Position, sodass die Summe exakt stimmt.
- **Zuschlags-Vorgaben** (Einstellungen › Zuschläge): je Kostenart Lohn, Material, Geräte, Fremdleistungen, Sonstiges. Sie gelten als Voreinstellung für neue Stammdaten und neue Preiskalkulationen; Änderungen wirken **nicht rückwirkend**. Verbesserung: optionale Sammelaktion „Zuschläge in Stammdaten aktualisieren“ mit Vorschau der Preisänderungen.
- Positionen ohne Kalkulation (nur VK) sind erlaubt; sie werden in Soll-Werten (Stunden, Kosten) gesondert ausgewiesen.
- **Soll-Stunden** eines Projekts = Σ Lohnzeit aller kalkulierten Positionen der ausgewählten Dokumente (Grundlage für Nachkalkulation und Plantafel).
- Alternativ- und Bedarfspositionen erscheinen im PDF, zählen aber nicht zur Summe.
- Rundung: kaufmännisch (half-up) auf Cent je Position; USt je Steuersatz auf der Summe (EN16931-konform).
- Alle Formeln sind reine Funktionen mit 100 % Testabdeckung und Referenzfällen.

#### 4.2.1 Einheiten

Einheiten werden einheitlich in Kalkulation, Aufmaß, Angeboten, Nachträgen und Rechnungen verwendet. Jede Einheit hat einen **UN/ECE-Code (Rec. 20/21)**, weil ZUGFeRD/XRechnung (BT-130) einen solchen Code verlangen. Im PDF wird das deutsche Kürzel gedruckt, in der E-Rechnung der Code.

| Kürzel (Anzeige) | Bezeichnung | Art | UN/ECE-Code | Nachkommastellen | Hinweise |
|---|---|---|---|---|---|
| `m` | Meter | Länge | `MTR` | 2 | Aufmaß-Vorlage Länge |
| `Lfm` | Laufender Meter | Länge | `LM` | 2 | Fußleisten, Fugen, Kabel, Rinnen |
| `km` | Kilometer | Länge | `KMT` | 2 | Anfahrt, Leitungstrassen |
| `m²` (Eingabe auch `m2`, `qm`) | Quadratmeter | Fläche | `MTK` | 2 | Hauptgrundlage für Wand-/Boden-/Dachflächen |
| `m³` (Eingabe auch `m3`, `cbm`) | Kubikmeter | Volumen | `MTQ` | 3 | Aushub, Beton, Estrich |
| `l` | Liter | Volumen | `LTR` | 2 | Farben, Grundierungen |
| `kg` | Kilogramm | Masse | `KGM` | 2 | |
| `t` | Tonne | Masse | `TNE` | 3 | Schüttgut, Entsorgung |
| `min` | Minute | Zeit | `MIN` | 0 | Kalkulationszeiten je Einheit |
| `Std` | Stunde | Zeit | `HUR` | 2 | Lohn, Regiearbeiten, Geräte |
| `Wo.` | Woche | Zeit | `WEE` | 1 | Gerüst-/Gerätevorhaltung, Container |
| `pa` | per annum (pro Jahr) | Zeit | `ANN` | 2 | Wartungsverträge, Miet-/Vorhaltekosten, Lizenzen |
| `Stk.` | Stück | Anzahl | `H87` | 0 | Standard-Zähleinheit |
| `Pkg` | Packung | Gebinde | `XPK` | 0 | |
| `Eimer` | Eimer | Gebinde | `XBJ` | 0 | |
| `Sack` | Sack | Gebinde | `XSA` | 0 | |
| `Rolle` | Rolle | Gebinde | `XRO` | 0 | |
| `Tube` | Tube | Gebinde | `XTU` | 0 | Silikon, Kleber |
| `psch` | Pauschal | Pauschale | `LS` | 0 | Menge immer 1; im PDF „psch“ ohne Einzelpreis-Logik (Positionstyp `lump_sum`) |
| `kWp` | Kilowatt Peak | Leistung | `KWT` | 2 | PV-Anlagen; Code ist kW, Kürzel bleibt „kWp“ |

**Regeln**
- Tabelle `unit` je Mandant, mit den oben genannten **Systemeinheiten** vorbelegt (nicht löschbar, Bezeichnung änderbar). Eigene Einheiten sind möglich, müssen aber einen UN/ECE-Code bekommen. Ohne Zuordnung wird `C62` („Einheit“) verwendet, mit Warnung vor dem Festschreiben.
- Felder: `symbol`, `name`, `dimension` (`length`, `area`, `volume`, `mass`, `time`, `count`, `container`, `lump_sum`, `power`), `unece_code`, `decimals`, `aliases[]` (Eingabe-Synonyme wie `m2`, `qm`), `is_system`.
- Festgeschriebene Dokumente speichern Kürzel **und** Code als Snapshot in jeder Position.
- **Umrechnungen** nur innerhalb einer Dimension: `min ↔ Std ↔ Wo. ↔ pa` (nur für Kalkulationshilfen, 1 pa = 52 Wo.), `kg ↔ t`, `m ↔ km`, `l ↔ m³`. `Lfm` und `m` sind gleichwertig umrechenbar.
- **Aufmaß**: Die Einheit der LV-Position bestimmt die passenden Vorlagen (m² → Fläche, m³ → Volumen, m/Lfm → Länge, Stk. → Zählen). Wenn die Formel-Dimension nicht zur Positionseinheit passt (z. B. Volumenformel bei m²-Position), erscheint ein Hinweis, aber keine Blockade.
- **Gebinde in der Kalkulation** (`Eimer`, `Sack`, `Rolle`, `Tube`, `Pkg`): Artikel haben einen Gebindeinhalt (z. B. Sack = 25 kg, Eimer = 12,5 l, Rolle = 10 m²). Mit einem Verbrauch je Leistungseinheit (z. B. 4 kg/m²) rechnet die Kalkulation den Materialbedarf in Gebinde um und **rundet auf ganze Gebinde auf** (optional pro Position abschaltbar).
- **Zeitwerte**: Kalkulationszeiten werden in `min` je Einheit erfasst (z. B. 18 min/m²) und für den Lohn in `Std` umgerechnet.

### 4.3 Aufmaß

**Zweck**: Das Aufmaß ist die Mengengrundlage für Angebot (Angebotsaufmaß), Abrechnung (Leistungsaufmaß) und Nachträge (Mehrmengen, Zusatzleistungen). Es ist abrechnungsrelevant und damit Teil der Nachweiskette einer Rechnung.

**Struktur**
- `measurement_sheet`: gehört zu einem Projekt, Art `survey` (vor Angebot) oder `performance` (ausgeführte Leistung), Status `draft` → `signed` (gemeinsames Aufmaß, Unterschrift beider Seiten mit Zeitstempel) .
- `measurement_location`: frei verschachtelbar (Haus A › EG › Bad), Räume mit optionalen Grunddaten (Länge, Breite, Höhe) als **Variablen** (`L`, `B`, `H`), die in Zeilen verwendet werden können.
- `measurement_line`: `formula` (Text, wie eingegeben), `variables` (jsonb), `result_qty numeric(18,4)` (serverseitig neu berechnet und gespeichert), `unit`, `is_deduction`, `document_item_id` (LV-Position aus Angebot/Auftrag/Nachtrag; darf vorübergehend leer sein = „nicht zugeordnet“), `note`, `photo_file_id`.

**Zwei Einstiege, ein Datenmodell**
- **Schnell-Aufmaß in der Position** (Angebots-/Rechnungseditor): Schalter „Aufmaß“ in der Position öffnet Zeilen *Beschreibung · Formel · Ergebnis*; die Menge der Position wird dann berechnet und gesperrt angezeigt („aus Aufmaß“). Technisch sind das `measurement_line`s auf einem automatisch angelegten Blatt des Projekts.
- **Aufmaßblatt** (Baustelle/Tablet): räumlich gegliederte Erfassung für viele Positionen; Zeilen werden Positionen zugeordnet.
- Beide Sichten zeigen dieselben Zeilen; eine Zeile, die im Blatt erfasst wurde, erscheint auch in der Position und umgekehrt.

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

### 4.5 Bautagebuch & Berichte

Bautagebuch und weitere Baustellendokumente werden einheitlich als **Berichte aus Vorlagen** abgebildet.

- `report_template`: Name, Feldschema (Textblöcke, Checklisten, Ja/Nein, Zahl mit Einheit, Datum/Uhrzeit, Personen/Stunden, Material, Fotos, Unterschriften, Wetter), **abrechenbar** ja/nein, aktiv/inaktiv, eigenes Briefpapier (Einstellungen › Briefpapier › Berichte).
- Mitgelieferte Systemvorlagen (anpassbar, nicht löschbar, deaktivierbar):

| Vorlage | Zweck | Abrechenbar |
|---|---|:-:|
| Bautagesbericht | Bautagebuch: Wetter, Personal, Leistungen, Vorkommnisse | ✔ |
| Regiebericht | Stundenlohnarbeiten (VOB/B § 15), Bestätigung durch Auftraggeber | ✔ |
| Einsatzbericht | Service-/Kundendiensteinsatz | ✔ |
| Abnahmeprotokoll | Abnahme mit Mängelliste, Vorbehalten, Unterschriften | ✔ |
| Aufmaß (Bericht) | Druckbares Aufmaßblatt zum gemeinsamen Aufmaß | – |
| Bedenkenanzeige | VOB/B § 4 Abs. 3, mit Frist und Nachweis des Zugangs | – |
| Behinderungsanzeige | VOB/B § 6 Abs. 1, Grundlage für Nachträge/Fristverlängerung | – |
| Baustellenbegehung | Begehung mit Fotos, Feststellungen, Aufgaben | – |
| Besprechungsprotokoll | Teilnehmer, Themen, Vereinbarungen, Fristen | – |
| Checkliste | Freie Prüfpunkte (z. B. Sicherheit, Übergabe) | – |
| Berichtsheft | Ausbildungsnachweis für Auszubildende | – |

- **Abrechenbare Berichte**: Stunden (je Lohngruppe), Material und Geräte aus dem Bericht können per Klick in eine Rechnung übernommen werden; übernommene Zeilen werden mit der Rechnung gesperrt (wie Aufmaßzeilen).
- Bedenken- und Behinderungsanzeigen haben einen Versandnachweis (Datum, Weg, Empfänger) und können direkt einen Nachtrag auslösen.

**Bautagesbericht (Bautagebuch) im Detail**
- `diary_entry` (project_id, date, weather jsonb, temperature, work_description, incidents, materials, equipment, status: draft|signed).
- Nach der Unterschrift ist der Eintrag gesperrt (Nachträge als verknüpfter Zusatzeintrag), weil das Bautagebuch Beweisfunktion hat (Behinderungsanzeigen, VOB/B § 6).
- Fotos: Original unverändert gespeichert (EXIF/GPS optional behalten, Hinweis Datenschutz), plus Thumbnails. Clientseitige Komprimierung optional abschaltbar.
- Wetter: Vorbefüllung über eine Wetter-API anhand der Baustellenkoordinaten (z. B. Open-Meteo/DWD), manuell überschreibbar.
- Aus einem Eintrag heraus: „Zusatzleistung / Behinderung erkannt“ → Nachtragsentwurf mit verknüpftem Eintrag und Fotos als Nachweis.

### 4.6 Zahlungen, Abzüge und Mahnungen

```
invoice ─┬─ payment (date, amount_cents, method, reference)
         ├─ receivable_adjustment (kind: cash_discount | retention | bank_fee | short_payment | other,
         │                         amount_cents, reason, disputed)
         └─ dunning_notice (level: reminder | first | final, date, due_date, fee_cents,
                            interest_rate, interest_cents, letter_snapshot, pdf → document_artifact)
```
- `open_amount = gross_total − Σ payment − Σ receivable_adjustment` (nie negativ; Überzahlung wird als Guthaben markiert).
- Zahlungen und Abzüge ändern **nicht** die festgeschriebene Rechnung, sie sind eigene, protokollierte Datensätze (Audit-Log). Löschen einer Zahlung ist bis zum DATEV-Export möglich, danach nur per Gegenbuchung.
- Status `overdue` ergibt sich aus Fälligkeit (Rechnungsdatum + Zahlungsziel) und offener Forderung; `dunned` sobald eine Mahnstufe versendet ist.
- Mahnungen sind keine Rechnungen (keine USt, kein Rechnungsnummernkreis), werden aber als PDF archiviert und am Rechnungsdatensatz geführt.

### 4.7 Audit-Log
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
- **Rollen & Rechte (RBAC)**: Zugriff = **Zugangsart** × **Rolle**.
  - Zugangsart *Büro* (Web + Mobil) oder *Baustelle* (nur Mobil/PWA im Baustellenmodus). Das ist auch die Grundlage für ein späteres Preismodell.
  - Systemrollen (kopierbar und anpassbar, je Mandant eigene Rollen möglich): **Inhaber/Admin**, **Büroleitung**, **Projektleitung**, **Teamleitung (Baustelle)**, **Teammitglied (Baustelle)**, dazu **Steuerberater/Prüfer** (nur lesen, befristet).
  - Rechte sind feingranulare Schlüssel (`project.read_all`, `project.write`, `project.archive`, `document.read`, `document.write`, `document.finalize`, `price.view`, `report.write`, `files.read_all`, `files.share`, `chat.delete_others`, `contacts.read`, `incoming_invoice.read`, `time.own`, `time.others`, `settings.read`, `settings.write`, `subscription.manage`, `export.run`, `audit.read` …). Die Rollen-Seite zeigt eine Matrix *Funktion × Web/Mobil* mit den Zuständen „erlaubt“, „nicht erlaubt“ und „auf diesem Gerät nicht verfügbar“ und darunter die Mitarbeitenden je Rolle.
  - Projektbezogene Rollen sehen nur Projekte, denen sie zugeordnet sind (`project_member`).

| Recht (Auszug) | Admin | Büroleitung | Projektleitung | Teamleitung | Teammitglied |
|---|:-:|:-:|:-:|:-:|:-:|
| Firma, Nutzer, Rollen, Abo | ✔ | – | – | – | – |
| Einstellungen ansehen / bearbeiten | ✔ / ✔ | ✔ / ✔ | ✔ / – | – | – |
| Alle Projekte sehen | ✔ | ✔ | zugewiesene | zugewiesene | zugewiesene |
| Projekte anlegen / bearbeiten / archivieren | ✔ | ✔ | ✔ / ✔ / – | – | – |
| Kontakte | ✔ | ✔ | ✔ | lesen | lesen (Projektkunde) |
| Angebote, Nachträge bearbeiten | ✔ | ✔ | ✔ | – | – |
| Rechnungen festschreiben / stornieren | ✔ | ✔ | – | – | – |
| Preise & Kalkulation sehen | ✔ | ✔ | ✔ | optional | – |
| Aufmaß erfassen | ✔ | ✔ | ✔ | ✔ | ✔ |
| Berichte erfassen / unterschreiben | ✔ | ✔ | ✔ | ✔ / ✔ | ✔ / – |
| Zeiten eigene / andere | ✔ / ✔ | ✔ / ✔ | ✔ / ✔ | ✔ / Team | ✔ / – |
| Eingangsrechnungen | ✔ | ✔ | lesen (Projekt) | – | – |
| Exporte (DATEV/GoBD), Audit-Log | ✔ | ✔ | – | – | – |

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
2. **Dashboard**: Kacheln „Offene Forderungen“ (offen/überfällig/angemahnt, Beträge ausblendbar für die Nutzung vor Kunden), „Zuletzt bearbeitete Projekte“ (Status direkt änderbar), „Offene Angebote & Nachträge“, „Heute auf der Baustelle“, „Wetter“; Schnellaktionen (Neues Projekt, Neues Angebot, Bericht erfassen).
3. **Projekt-Detail**: Kopf (Projektname, Status-Auswahl, Mitarbeitende, Bearbeiten); Kacheln Kunde (mit Telefon zum Antippen), Baustelle (Kartenlink), Zeitraum, Stunden Ist/Soll, Auftragssumme/abgerechnet; Bereiche Dokumente (gruppiert nach Typ mit Status) · Aufmaß · Nachträge · Berichte · Ablage · Zahlungen; Aktionen „Neues Dokument“, „Bericht erfassen“, „Aufmaß“.
4. **Angebots-Editor**: links Gliederung (Kopf, LV-Titel als Sprungmarken, Nettosumme) mit Drag & Drop; Mitte das Dokument *so wie es gedruckt wird* (Kopfdaten, Anfangstext, LV-Tabelle Pos · Menge · Einheit · Beschreibung · EP · GP, Schlusstext); Einfügen von Text, Titel, Position, Bild an jeder Stelle (Einfügeleiste + Tastenkürzel); Suche in Stammdaten inkl. Katalogen (`/`); Position aufklappbar mit Kurz-/Langtext, Rabatt, **Aufmaß-Zeilen** und **Kostenzeilen** (siehe §4.2), Badges „aus Aufmaß“ / „kalkuliert“; Langtexte global ein-/ausblendbar; Autosave mit Statusanzeige; „Weiter zur Vorschau“ zeigt das PDF; Anhänge.
   *Unser Unterschied*: Kalkulationsübersicht je Titel (Lohn/Material/Gerät, Stunden, Marge) jederzeit einblendbar; auf dem Tablet einspaltig mit Bottom Sheet für Kalkulation/Aufmaß.
5. **Aufmaß (Tablet/Phone)**: oben Raum-Navigation (Haus › Geschoss › Raum), darunter Zeilenliste; Eingabe über eigene **Zahlen-/Formel-Tastatur** (große Tasten, `×`, `−`, Klammern, Komma) mit Live-Ergebnis; Positions-Auswahl per Suche oder „zuletzt verwendet“; Vorlagen-Chips (Rechteck, Wand, Abzug Tür/Fenster); Summe je Position und Abweichung zur LV-Menge farbig; Foto/Skizze je Zeile; Unterschrift für gemeinsames Aufmaß.
6. **Nachträge**: Liste je Projekt mit Status-Badges und Summen; Editor wie Angebot, zusätzlich Grund, Rechtsgrundlage und Nachweis-Picker (Tagebuch, Fotos, Aufmaß); Leiste „Vertragssumme: Hauptauftrag + Nachträge“.
7. **Rechnung aus Auftrag**: Assistent „Abschlag / Schluss“: Mengen aus Leistungsaufmaß übernehmen, Positionen aus Hauptauftrag und beauftragten Nachträgen, Vorschau der Anrechnungen und Mehr-/Mindermengen.
8. **Bautagebuch mobil**: Ein Bildschirm, ein Daumen: Datum (heute), Wetter vorbefüllt, Chips für Anwesende, Textfeld mit Diktierfunktion des Geräts, Foto-Button groß, „Speichern“ funktioniert offline (Sync-Indikator), Aktion „Nachtrag anlegen“.
9. **Export-Center**: Zeitraum wählen → DATEV / Betriebsprüfung (Z3) / Komplett-Export, mit Erklärungstext.

### 7.4 Navigation & Einstellungen (Informationsarchitektur)

**Hauptnavigation** (Desktop-Seitenleiste; mobil: 4 Hauptpunkte + „Mehr“):
Suchen · Benachrichtigungen · Übersicht · Projekte · Angebote · Ausgangsrechnungen · Kontakte · Stammdaten · *(Phase 2: Plantafel · Zeiten · Eingangsrechnungen)* · unten Hilfe, Neuigkeiten, Profil, Firmenwechsel (ein Nutzer kann mehreren Firmen angehören).

**Einstellungen**, gruppiert:
| Gruppe | Punkte |
|---|---|
| Unternehmen | Mitarbeitende · Unternehmen (Stammdaten, Kontakt, Logo, Rechtliches, Bank) · Vertrag/Abo · Arbeitszeiten · Feiertage (Bundesland, automatisch berechnet, ergänzbar) · Rollen & Zugriffsrechte · Schnittstellen (DATEV, später weitere) |
| Layout & Texte | Briefpapier (Dokumente / Berichte) · Anfangs- & Schlusstexte je Dokumenttyp · Berichtsvorlagen · Ablage-Ordnerstruktur für Projekte · Automatische Anhänge (z. B. AGB an jedes Angebot) · Dateinamen-Muster (z. B. `{Typ}_{Nummer}_{Kunde}`) · E-Mail-Versand (Absender, Vorlagen, BCC) |
| Buchhaltung & Rechnungswesen | Nummernkreise · Zahlungsziel & Skonto · Lohnkostenanteil ausweisen (§ 35a; Matrix *Rechnungen / Angebotsdokumente* × *Personen / Organisationen*, Standard: Rechnungen an Personen) · Bezahlcode · Mahnungen · Abschlagsrechnungen · DATEV-Konten |
| Kalkulation | Lohngruppen · Zuschläge · Einheiten |

**Nummernkreise** (Vorgaben, alle änderbar bis zur ersten Verwendung): Kunden `K-` ab 10001, Projekte `P-`, Angebote `A-`, Kostenvoranschläge `KV-`, Auftragsbestätigungen `AB-`, Nachträge je Projekt `N01…`, Lieferscheine `LS-`, Rechnungen `R-`, Gutschriften `G-` (je ab 101, Mindestlänge 5 mit führenden Nullen). Zusätzlich optional Jahresbestandteil (`R-2026-00001`) mit jährlichem Neubeginn. Rechnungs- und Gutschriftenkreise dürfen nach der ersten Festschreibung nur noch erhöht, nie verringert werden (Lückenlosigkeit).

**Einstellungsseiten** folgen einem Muster: Karten mit Lesesicht und Schaltfläche „Bearbeiten“; Info-Symbol mit kurzer Erklärung *warum* eine Angabe nötig ist (z. B. „Pflichtangabe auf Rechnungen nach § 14 UStG“).

**Hinweise im Kopfbereich**: Fehlende Pflichtangaben (z. B. Steuernummer leer, E-Mail nicht bestätigt) erscheinen als gelbe Leiste mit Direktlink, *bevor* sie beim Festschreiben stören.

### 7.5 Briefpapier & Dokumentlayout

- **Automatisches Layout** aus den Firmendaten (Logo, Anschrift, Kontakt, Bank, Rechtliches in der Fußzeile) als Standard; alternativ **eigener Hintergrund** (PDF oder Bild in A4) mit getrenntem Hintergrund ab Seite 2 und einstellbaren Rändern oben/unten.
- Getrennte Einstellungen für **Dokumente** und **Berichte**.
- Aufbau nach **DIN 5008** (Anschriftfeld für Fensterumschlag, Absenderzeile über der Anschrift, Infoblock rechts mit Nummer, Datum, Kundennummer, Ansprechpartner).
- Entwürfe tragen sichtbar „Entwurf“ im Titel; festgeschriebene Dokumente zeigen Nummer und Datum.
- Live-Vorschau neben den Einstellungen; „Briefpapier prüfen“ meldet fehlende Pflichtangaben.
- LV-Druck: Pos · Menge · Einheit · Beschreibung (Kurztext fett, Langtext normal) · EP · GP; Titelsummen; Alternativ-/Bedarfspositionen gekennzeichnet; optionale Anlagen: Aufmaßblatt, Berichte, Fotos.

### 7.6 Verbesserungen gegenüber dem Marktstandard (bewusst anders)

1. **Aufmaß im Kern**: neben dem Schnell-Aufmaß in der Position ein echtes Aufmaßblatt mit Räumen, Variablen, Abzügen, offline – und Mengenfortschreibung bis in die Schlussrechnung.
2. **Nachträge als eigener Prozess** mit Rechtsgrundlage, Nachweisen aus Berichten und Vertragssumme.
3. **Rechnungskorrektur ohne Frust**: „Korrigieren“ erledigt Storno + neue Rechnung in einem Schritt und erklärt es.
4. **Kalkulation transparent**: Marge, Stunden und Kostenarten je Titel live sichtbar.
5. **Mobil gleichwertig**: Berichte, Aufmaß und Fotos sind auf dem Handy erste Klasse, nicht nur Lesesicht.
6. **Sprach-/Fotonotizen** an Berichten und Positionen (häufig gewünscht), Fotomarkierung in Phase 3.

### 7.7 UX-Regeln für Compliance
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
6. **Eingangsrechnungen** schon ins MVP? Seit 2025 müssen alle Betriebe E-Rechnungen empfangen können; eine einfache Ablage mit lesbarer Darstellung, Projektzuordnung und Archiv wäre ein starkes Argument. Vorschlag: Basisversion ans Ende des MVP.
7. **Projekt-Chat** im MVP oder Phase 2? (Vorschlag: Phase 2; im MVP Kommentare an Dokumenten und Berichten.)
8. **Schlussrechnung & Abschläge**: Bitte mit dem Steuerberater bestätigen, dass in der Schlussrechnung alle gestellten Abschlagsrechnungen (nicht nur die bezahlten) mit Steuerbetrag abgezogen werden (DESIGN.md §4.1). Alternative: nur vereinnahmte Teilentgelte abziehen. Beides ist konfigurierbar vorgesehen.
