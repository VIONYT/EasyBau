# 2. Anwenderdokumentation

Die Bedienung im Einzelnen beschreibt das [Benutzerhandbuch](../handbuch/README.md). Hier steht, **wie Belege entstehen und ab wann sie unveränderlich sind**.

## 2.1 Ausgangsbelege

| Beleg | Entstehung | Unveränderlich ab | Nummer |
|---|---|---|---|
| Angebot, Kostenvoranschlag, Auftragsbestätigung, Nachtragsangebot | Entwurf im Projekt, Positionen mit Kalkulation | „Fertigstellen“ | beim Fertigstellen aus dem Nummernkreis |
| Rechnung (Standard, Abschlag, Teil, Schluss), Gutschrift | Entwurf, Mengen aus Auftrag und Aufmaß, Regieberichte | **„Festschreiben“** | beim Festschreiben, lückenlos, nie wiederverwendet |
| Stornorechnung | „Rechnung stornieren“ / „Rechnung korrigieren“ | sofort festgeschrieben | eigene neue Nummer |
| Zahlungserinnerung / Mahnung | aus der überfälligen Rechnung | sofort | – (Verweis auf die Rechnung) |

**Festschreiben** einer Rechnung (in einem Schritt, alles oder nichts):
1. Prüfung der Pflichtangaben nach § 14 Abs. 4 UStG (Firma, Steuernummer, Leistungszeitraum, Empfänger …); Fehler verhindern das Festschreiben, Hinweise müssen bestätigt werden.
2. Vergabe der Rechnungsnummer aus dem Nummernkreis.
3. Kopie (Snapshot) von Kunde, Anschrift, Firmendaten, Steuersätzen und Briefpapier in die Rechnung – spätere Änderungen an Stammdaten wirken nicht zurück.
4. Erzeugen der E-Rechnung (ZUGFeRD EN 16931, bei Bedarf XRechnung) und Prüfung mit dem KoSIT-Validator; abgelehnt → kein Festschreiben, keine Nummer.
5. Erzeugen des PDF/A-3 mit eingebetteter E-Rechnung; Ablage als Original mit SHA-256.

**Korrektur:** Eine festgeschriebene Rechnung wird nie geändert oder gelöscht. Fehler werden durch eine Stornorechnung (eigene Nummer, Verweis auf das Original) und eine neue Rechnung korrigiert; die stornierte Rechnung bleibt mit Nummer erhalten.

**Aufmaß und Berichte:** Aufmaßzeilen, die in eine festgeschriebene Rechnung eingeflossen sind, und unterschriebene Aufmaßblätter/Berichte sind gesperrt; Korrekturen nur über neue Zeilen bzw. neue Blätter.

[[Eigene Regeln, z. B.: Wer darf festschreiben? Werden Rechnungen vor dem Festschreiben von einer zweiten Person geprüft?]]

## 2.2 Zahlungen, Abzüge, Mahnungen

- Zahlungen und Abzüge (Skonto, Einbehalt, Kürzung …) werden je Rechnung erfasst; sie ändern die Rechnung nicht. Fehler werden durch eine Gegenbuchung ausgeglichen, beide Einträge bleiben sichtbar.
- Der offene Betrag ergibt sich immer aus Rechnung, Zahlungen und Abzügen.
- Mahnungen werden mit Verzugszinsen (§ 288 BGB, Basiszinssatz der Bundesbank) berechnet, sofort festgeschrieben und als PDF/A archiviert.
- [[Zahlungseingänge werden erfasst von … anhand der Kontoauszüge vom …; Abgleich wöchentlich/monatlich.]]

## 2.3 Eingangsrechnungen

- Eingang per Upload (PDF, Foto, ZUGFeRD, XRechnung) oder automatisch aus dem Postfach [[Adresse, z. B. rechnung@firma.de]].
- Das Original wird beim Eingang unverändert mit SHA-256 abgelegt; Dubletten (gleiche Datei) werden abgewiesen.
- E-Rechnungen werden aus dem XML gelesen und mit KoSIT geprüft (Ergebnis als Hinweis).
- Prüfung: Lieferant, Nummer, Datum, Beträge je Steuersatz, Kostenzuweisung auf Projekte oder Betriebsbereiche. **„Prüfung bestätigen“** friert die Daten ein; danach nur noch Zahlstatus oder Storno.
- [[Wer prüft sachlich (Leistung erbracht?) und rechnerisch? Freigabe für die Zahlung durch …]]

## 2.4 Weitergabe an die Steuerberatung

- [[Monatlich bis zum …]]: Export „DATEV“ (Buchungsstapel EXTF mit Ausgangsrechnungen, Zahlungen, anerkannten Kürzungen und bestätigten Eingangsrechnungen, inkl. Belegen) an [[Kanzlei]] per [[Weg]].
- Kontenzuordnung (SKR03/SKR04, Erlös- und Aufwandskonten, Kreditoren) ist mit der Steuerberatung abgestimmt am [[Datum]] und in EasyBau unter Einstellungen › Exporte hinterlegt.
