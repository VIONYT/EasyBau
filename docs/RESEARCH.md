# Recherche: Was Plancraft für Baufirmen attraktiv macht

Stand: November 2026. Ziel dieser Recherche ist **nicht**, Plancraft zu kopieren (Texte, Marke, Look), sondern zu verstehen, welches *Problem* das Produkt für Bau- und Handwerksbetriebe löst, um ein eigenständiges System mit vergleichbarem Nutzen zu bauen.

> Hinweis: plancraft.com war aus der Arbeitsumgebung nicht direkt erreichbar. Die Angaben stammen aus Testberichten, Software-Verzeichnissen und Nutzerbewertungen (Quellen am Ende). Funktionen und Preise sollten vor Produktentscheidungen in einer Demo verifiziert werden.

## 1. Zielgruppe

- Bau- und Ausbaugewerbe (Maler, Trockenbau, Zimmerer/Holzbau, Elektro, SHK, Fliesen, Dachdecker, GaLaBau, Rohbau).
- Schwerpunkt **kleine und mittlere Betriebe, ca. 1–40 Mitarbeitende**. Der Inhaber macht das Büro oft abends selbst; es gibt keine IT-Abteilung.
- Deutschland, inzwischen auch Österreich (relevant für die Mandantenfähigkeit bei Steuer- und Rechnungsformaten).

## 2. Warum Betriebe es mögen (Kernnutzen)

| Treiber | Was Nutzer sagen / was beworben wird | Konsequenz für uns |
|---|---|---|
| **Einfachheit** | Durchgehend „einfach und selbsterklärend“, Bewertung für Bedienkomfort ~4,9/5 | Wenige Klicks, klare Sprache, Handwerker-Vokabular, keine ERP-Masken mit 80 Feldern |
| **Alles an einem Ort** | Kunden, Dokumente, Fotos, Bautagebuch pro Projekt | Das **Projekt** ist das zentrale Objekt, nicht das Dokument |
| **Schnelle, professionelle Angebote** | Kalkulation mit Suche, Lohnkalkulation, Leistungsverzeichnis, Vorlagen; KI-Angebot per Chat | Angebotseditor ist das Herzstück und muss besonders gut sein |
| **Durchgängiger Dokumentenfluss** | Angebot → Auftragsbestätigung → Abschlagsrechnung → Schlussrechnung | Dokumente werden voneinander abgeleitet, nie neu getippt |
| **Mobil auf der Baustelle** | iOS/Android, Aufmaß auf dem Tablet, Fotos, Bautagebuch | Mobile-first-Baustellenmodule, offlinefähig |
| **Keine Installation, Cloud** | In wenigen Minuten nutzbar, Updates inklusive | Web-App/PWA, Onboarding in unter 10 Minuten |
| **Übergabe an den Steuerberater** | DATEV-Export, GoBD, E-Rechnung | Compliance ist Verkaufsargument, kein Nebenthema |
| **Großhandel und Ausschreibungen** | DATANORM-Kataloge (z. B. Sonepar, Würth), GAEB-Import und -Export (in höheren Tarifen) | Schnittstellen modular planen, nicht im MVP |
| **Persönlicher Support** | Hersteller reagiert mit Tipps (z. B. zu Rechnungsänderungen) | In-App-Hilfe, verständliche Fehlermeldungen, die *erklären* (z. B. warum eine Rechnung nicht mehr änderbar ist) |

### Kritikpunkte und Lücken (unsere Chance)
- Preis für Kleinstbetriebe hoch (Einstieg ca. 50–60 €/Monat, GAEB/DATANORM erst im Pro-Tarif um 110 €/Monat).
- Fehlende Sprachnachrichten und Fotobearbeitung (Markieren, Pfeile) wurden bemängelt.
- Änderungen an Rechnungen wirken für Nutzer kompliziert. GoBD erzwingt das, die UX muss es aber erklären („Korrigieren“ erzeugt Storno + neue Rechnung mit einem Klick).

## 3. Funktionsübersicht des Marktstandards

Angebote, Auftragsbestätigungen, Abschlags-, Teil- und Schlussrechnungen, Gutschriften, Lieferscheine, Leistungsverzeichnisse, Kalkulation inkl. Lohn, Aufmaß (Formeln, Tablet, Spracheingabe per KI), Fotodokumentation, Bautagebuch, Zeiterfassung, Plantafel, Nachkalkulation, E-Rechnung (ZUGFeRD/XRechnung), Eingangsrechnungs-Scan per KI, KI-Telefonassistent, Mahnwesen, Schnittstellen CSV/Excel/DATEV/DATANORM 4.0/GAEB.

## 4. Rechtlicher Rahmen (Deutschland), der das Design bestimmt

1. **GoBD** (BMF-Auslegung zu §§ 146, 147 AO): Unveränderbarkeit, Nachvollziehbarkeit, Vollständigkeit, Ordnung, zeitgerechte Erfassung, maschinelle Auswertbarkeit, Verfahrensdokumentation. Festgeschriebene Rechnungen dürfen **nicht geändert oder gelöscht** werden. Korrekturen laufen über Storno bzw. Korrekturrechnung mit eigener Nummer.
2. **Datenzugriff der Finanzverwaltung** (§ 147 Abs. 6 AO): Z1 (unmittelbar), Z2 (mittelbar), Z3 (**Datenträgerüberlassung**). Daraus folgt: Export aller steuerrelevanten Daten in maschinell auswertbarer Form (CSV + `index.xml` nach Beschreibungsstandard).
3. **E-Rechnung** (§ 14 UStG, Wachstumschancengesetz): Empfang B2B ist seit 01.01.2025 Pflicht. Versandpflicht gilt ab 01.01.2027 für Unternehmen mit mehr als 800.000 € Vorjahresumsatz, ab 01.01.2028 für alle. Formate: XRechnung (UBL/CII) und ZUGFeRD ab 2.0.1 (nicht MINIMUM/BASIC-WL), Norm EN 16931. Bei ZUGFeRD ist das hybride PDF das Original, bei XRechnung das XML. Das Original muss **unverändert archiviert** werden.
4. **Aufbewahrung**: Buchungsbelege (Rechnungen) seit BEG IV 8 Jahre, Bücher und Jahresabschlüsse 10 Jahre, Handelsbriefe 6 Jahre. Wir bewahren standardmäßig **10 Jahre** auf (konservativ, konfigurierbar) und sperren Löschungen vor Fristablauf.
5. **Bau-Spezifika**: § 13b UStG (Reverse Charge bei Bauleistungen an Bauleistende), § 35a EStG (Ausweis des Lohnanteils für Privatkunden), § 14 Abs. 4 Nr. 9 UStG (Hinweis auf 2-jährige Aufbewahrungspflicht für Privatkunden bei Leistungen am Grundstück), Abschlagsrechnungen nach § 632a BGB / § 16 VOB/B, Sicherheitseinbehalt, Skonto, Bauabzugsteuer-Freistellung (§ 48b EStG), VOB/B-Fristen.
6. **DSGVO**: Hosting in der EU, AVV mit Kunden, Löschkonzept (kollidiert mit Aufbewahrungspflichten, daher Sperren statt Löschen), Datenexport (Art. 20).

## 5. Ableitung: Was zum Start besonders wichtig ist (MVP)

Priorität nach Nutzen × Häufigkeit × Pflicht:

1. **Kundenverwaltung** (Kontakte, Adressen, Ansprechpartner, Privat/Gewerbe, § 13b-Kennzeichen)
2. **Projekte** als Klammer (Baustelle, Status, Dokumente, Fotos)
3. **Aufmaß** (Angebots- und Leistungsaufmaß mit Formeln, Räumen, Abzügen; offline auf dem Tablet). Im Baugewerbe ist das Aufmaß die Mengengrundlage für Angebot, Kalkulation und Abrechnung. Bei Einheitspreisverträgen wird nach Aufmaß abgerechnet.
4. **Angebotserstellung mit Kalkulation** (Titel/Positionen, Lohn/Material/Gerät/Fremdleistung, Zuschläge, Vorlagen, Artikel- und Leistungsstamm, professionelles PDF, Mengen aus dem Aufmaß)
5. **Auftragsbestätigung und Nachträge** (Nachtragsangebote zum Hauptauftrag nach VOB/B § 2 Abs. 5/6 bzw. BGB § 650b, Nachweise aus Bautagebuch/Fotos/Aufmaß, Beauftragungsstatus). Nicht oder zu spät gestellte Nachträge sind eine der häufigsten Ursachen für Verluste am Bau.
6. **Rechnungen** (Abschlag aus Leistungsaufmaß, Schluss mit Anrechnung, Storno/Korrektur) **GoBD-konform** mit **ZUGFeRD/XRechnung**
7. **Zahlungsstatus** (offen / teilbezahlt / bezahlt / überfällig) und einfache Zahlungserinnerung
8. **Bautagebuch** mobil + offline (Wetter, Personal, Tätigkeiten, Fotos, Behinderungen, Unterschrift, PDF), direkt verknüpft mit Nachträgen
9. **Steuerberater- und Finanzamtsexport**: DATEV-Buchungsstapel, GoBD-Datenträgerüberlassung (Z3), revisionssicheres Archiv
10. **Sicherheit**: 2FA, Rollen (Inhaber, Büro, Bauleiter, Monteur), Audit-Log, Backups

Bewusst **nach** dem MVP: Zeiterfassung, Aufmaß-Austausch (REB/GAEB X31), DATANORM, GAEB, Plantafel, Eingangsrechnungen/OCR, Nachkalkulation, Mahnstufen, Kundenportal mit Online-Annahme, KI-Funktionen, Bankanbindung.

## 6. Erkenntnisse aus Produkt-Screenshots (Nov. 2026)

Der Auftraggeber hat Screenshots einer Testinstanz bereitgestellt. Ausgewertet wurden nur Abläufe, Funktionen und Informationsarchitektur; Optik und Texte werden nicht übernommen, die Bilder liegen nicht im Repository. Die Ergebnisse sind in DESIGN.md eingearbeitet (§2, §4.2, §4.3, §4.5, §7.3–§7.6).

- **Navigation**: Suche, Benachrichtigungen, Übersicht, Anrufe (KI-Telefon), Projekte, Plantafel, Angebote, Ausgangs-/Eingangsrechnungen, Zeiten, Stammdaten, Kontakte; Firmenwechsel oben.
- **Einstellungen** in vier Gruppen: Unternehmen · Layout & Textvorlagen · Buchhaltung & Rechnungswesen · Kalkulation (Lohngruppen, Zuschläge, Einheiten).
- **Berichtsvorlagen** statt starrem Bautagebuch; einige Vorlagen sind „abrechenbar“ (Bautagesbericht, Regiebericht, Einsatzbericht, Abnahmeprotokoll).
- **Nummernkreise** mit Kürzel, Startwert, Mindestlänge für Kunden, Projekte, Angebote, Kostenvoranschläge, AB, Lieferscheine, Rechnungen, Gutschriften. Ein Jahresbestandteil wurde nicht beobachtet. Bei uns ist er optional.
- **Kontakte**: Person/Organisation, verknüpfte Kontakte, Farbe, Labels an Kanälen, abweichender Empfänger, je Kontakt Zahlungsziel, Steuersatz und XRechnung-Daten.
- **Projekt**: Status-Pipeline ab „Erstkontakt“, Zeitraum, Mitarbeitende, Stunden Ist/Soll aus der Kalkulation, Nachkalkulation, Dokumente/Berichte/Ablage, Projekt-Chat mit Galerie.
- **Angebotseditor**: Dokumentansicht mit Gliederung links, Einfügen von Text/Titel/Position/Bild, Kopf mit Leistungsort. Je Position gibt es ein Inline-Aufmaß (Beschreibung/Formel/Ergebnis) und Kostenzeilen (Art, Menge, Einheit, EK) im Modus Einheits- oder Gesamtpreis.
- **Stammdaten**: Leistungen (Kosten, Zuschlag, VK), Materialien (Art.-Nr., EK, Zuschlag, VK), DATANORM-Kataloge, die optional in die Materialsuche einbezogen werden.
- **Eingangsrechnungen**: Upload von PDF/XML/Bild, Bereich „Zu prüfen“, Kostenzuweisung, Zahlstatus.
- **Dashboard**: offene Forderungen (offen/überfällig/angemahnt, ausblendbar), zuletzt bearbeitete Projekte, Wetter.
- **Dokumente**: Dialog „Neues Dokument“ mit Angebot, Kostenvoranschlag, Auftragsbestätigung, Lieferschein, Rechnung und fortlaufend gezählten Abschlagsrechnungen („1. Abschlagsrechnung“). **Nachtragsangebot** gibt es als eigenen Dokumenttyp mit demselben Editor.
- **Dokument-Fuß**: Netto/USt/Brutto, „Preis anpassen“ (Zielpreis), Rabatt, Umsatzsteuer je Dokument (Land + Satz), Lohnkostenanteil-Schalter, Zahlungsziel/Skonto je Dokument.
- **Neues Projekt**: Name (Pflicht), Beschreibung, Projektnummer manuell oder per Klick automatisch, Status (auch leer), Mitarbeitende, Kunde aus Kontakten, Baustellenadresse = Leistungsort.
- **Neue Leistung**: Seitenpanel mit Pflicht-Ordner, Einheit, Kurztext, Kosten, Zuschlag → VK, optional Langtext, Bild, Preiskalkulation.
- **Ausgangsrechnungen**: Liste mit Status-Mehrfachfilter (Entwurf, offen, bezahlt, überfällig, angemahnt, storniert), Art, Projekt, „mit Sicherheitseinbehalt“, netto/brutto. Zeilenmenü mit PDF, XRechnung, Kürzen, Stornieren. Storno-Dialog mit Grund und Option „neu ausstellen“.
- **Rechnungsdetail**: offene Forderung, Zahlungen, Abzüge, Kürzen, Notiz, zusammenhängende Dokumente. Zahlungserinnerung, 1. und 2. Mahnung werden nacheinander erzeugt.
- **Einstellungen**: Mahnstufen mit Frist, Verzugszinsen und Gebühr; Bezahlcode (Name, IBAN, Betrag ohne Skonto, Rechnungsnummer); Abschläge kumulativ als Standard; Zuschläge je Kostenart (nicht rückwirkend); Lohnkostenanteil-Matrix (Rechnungen/Angebote × Personen/Organisationen); Zahlungsziel 7 Tage, kein Skonto als Vorgabe.
- **Eingangsrechnung**: Belegvorschau mit per KI ausgelesenen Daten (Lieferant, Nummer, Datum, Netto, Zahlstatus), Kostenzuweisung mit Restbetrag oder je Position, „Prüfung bestätigen“.
- **Schlussrechnung**: Quelldokument wird im Dialog gewählt (Abschläge, Angebote, Nachtragsangebote) oder leer begonnen. Im Kopf stehen Leistungszeitraum, Leistungsort und eine Referenz auf den Abschlag. Die „Zahlungsaufstellung“ zieht **Zahlungen** ab; ein unbezahlter Abschlag erschien dort als „keine Zahlungen“. Ein Schlusstext ersetzt bisherige Abschläge, dazu kommt der Standardsatz „Leistungsdatum = Rechnungsdatum“. Die Vorschau hat die Aktion „Dokument fertigstellen“.
- **Kostenzuweisung (Eingang)**: Projekt oder Betriebsbereich (Lager, Büro, Mitarbeiter, Fahrzeuge, Werkstatt, Sonstiges), Betrag und Kostenart, mehrfach aufteilbar.
- **Beobachtete Lücken / Chancen**:
  - In der Schlussrechnung werden Zahlungen statt gestellter Abschlagsrechnungen gegengerechnet. Bei unbezahlten Abschlägen kann so Umsatzsteuer doppelt ausgewiesen werden; wir ziehen die gestellten Abschläge mit ihrer Steuer ab (DESIGN.md §4.1).
  - Das Aufmaß besteht nur aus Zeilen in der Position. Räume, Variablen und eine Mengenfortschreibung sind nicht sichtbar.
  - Das Nachtragsangebot ist ein Dokumenttyp. Rechtsgrundlage, Nachweise, Beauftragungsstatus und Vertragssumme (Hauptauftrag + Nachträge) waren nicht sichtbar. Das ist unser Ansatzpunkt (DESIGN.md §4.4).
  - Es gibt keine Jahres-Nummernkreise.

## Quellen
- [SoftGuide – plancraft](https://www.softguide.de/programm/plancraft)
- [Handwerksblatt – plancraft will Software für das Handwerk möglichst einfach halten](https://www.handwerksblatt.de/betriebsfuehrung/plancraft-will-software-fuer-das-handwerk-moeglichst-einfach-halten)
- [Capterra – plancraft Reviews](https://www.capterra.com/p/250754/Plancraft/reviews/)
- [Capterra DE – plancraft](https://www.capterra.com.de/software/186906/plancraft)
- [trusted.de – plancraft](https://trusted.de/plancraft)
- [softwareabc24 – plancraft](https://www.softwareabc24.de/handwerker-software/plancraft)
- [OMR Reviews – plancraft](https://www.omr.com/de/reviews/product/plancraft)
- [für-gründer.de – Handwerkersoftware für Kleinbetriebe](https://www.fuer-gruender.de/wissen/unternehmen-fuehren/buchhaltung/handwerker-software-vergleich/handwerkersoftware-kleinbetriebe/)
- [ki-syndikat.de – plancraft KI-Funktionen](https://www.ki-syndikat.de/tools/plancraft/)
- [findskill.ai – Plancraft vs ToolTime vs HERO 2026](https://findskill.ai/de/blog/handwerker-software-vergleich-2026/)
- [plancraft.de – Software Office](https://plancraft.de/en/features/plancraft-software-office)
- [steuerschroeder.de – E-Rechnung, § 14 UStG, GoBD](https://www.steuerschroeder.de/elektronische-Rechnung.html)
- [kostenlose-erechnung.de – GoBD-Rechnung](https://kostenlose-erechnung.de/ratgeber/rechnung-gobd-erstellen/)
- [kostenlose-erechnung.de – Prüferexport/Betriebsprüfung](https://kostenlose-erechnung.de/ratgeber/gobd-betriebspruefung-vorbereiten-prueferexport/)
- [Börse Express – E-Rechnungspflicht ab 2027](https://www.boerse-express.com/news/articles/e-rechnungspflicht-ab-januar-2027-muessen-grosse-firmen-umstellen-925119)
