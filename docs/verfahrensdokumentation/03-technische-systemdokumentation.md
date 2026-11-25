# 3. Technische Systemdokumentation

Beschreibung des Programms EasyBau; Einzelheiten stehen in der [Architektur (DESIGN.md)](../../DESIGN.md) und den [Architekturentscheidungen](../adr/).

## 3.1 Aufbau

- Web-Anwendung (Browser, auch als App auf Smartphone/Tablet), Server-Anwendung (API und Hintergrunddienst), Datenbank **PostgreSQL 17**, Validator **KoSIT** für E-Rechnungen, Objektspeicher mit **Object Lock** (RustFS im Stack oder externer S3) für das Belegarchiv, Webserver **Caddy** (HTTPS). Betrieb mit Docker Compose auf [[Server]].
- Alle Programmteile sind Open Source; der Quellcode der eingesetzten Version ist vollständig einsehbar ([[Repository/Tag]]).

## 3.2 Unveränderbarkeit (GoBD Rz. 58 ff.)

| Maßnahme | Wirkung |
|---|---|
| Festschreiben | Festgeschriebene Rechnungen, ihre Positionen und Summen können nicht mehr geändert oder gelöscht werden – Sperre durch Datenbank-Trigger (nicht nur in der Oberfläche). |
| Snapshots | Empfänger-, Firmen- und Steuerdaten werden beim Festschreiben in den Beleg kopiert. |
| Originale | PDF/A-3, E-Rechnungs-XML und Prüfbericht werden einmal erzeugt und mit SHA-256 gespeichert; ausgeliefert wird immer dieses Original. |
| Belegarchiv (WORM) | Jedes Original wird in einen Bucket mit Object Lock im Compliance-Modus kopiert; Sperrfrist = Ende der Aufbewahrungsfrist (Standard: Ende des Kalenderjahres + 10 Jahre, Mahnungen 6 Jahre). Der Zugang der Anwendung hat kein Löschrecht. Ein nächtlicher Abgleich prüft Vorhandensein, Prüfsumme und Sperrfrist und stellt fehlende Kopien aus der Arbeitskopie wieder her. |
| Zahlungen, Abzüge, Mahnungen | nur hinzufügen, nie ändern/löschen; Korrektur per Gegenbuchung. |
| Eingangsrechnungen | Original unveränderlich, Daten nach „Prüfung bestätigen“ eingefroren, nie löschbar. |

## 3.3 Änderungsprotokoll (Audit-Kette)

- Jede Änderung steuerrelevanter Daten (Stammdaten, Belege, Zahlungen, Einstellungen zu Steuern und Nummernkreisen …) schreibt in derselben Transaktion einen Eintrag mit Zeit, Person, Aktion, altem und neuem Stand.
- Die Einträge je Firma sind durch eine Hash-Kette verbunden und können nicht geändert oder gelöscht werden (Datenbank-Trigger).
- Die Kette wird jede Nacht vollständig geprüft; dabei wird der letzte Eintrag verankert, sodass auch Kürzungen oder komplette Neuberechnungen auffallen. Ergebnis im Betriebs-Check; bei Problemen E-Mail an die Admins.
- Einsicht: Bereich **Prüfung** (Filter nach Zeitraum, Beleg, Datensatz).

## 3.4 Nummernkreise

- Nummern für Rechnungen/Gutschriften, Angebote usw. werden erst beim Festschreiben bzw. Fertigstellen vergeben, in derselben Transaktion und gesperrt gegen gleichzeitige Vergabe: lückenlos, eindeutig, nie wiederverwendet (auch nicht nach Storno). Schema je Kreis einstellbar (z. B. `R-{Jahr}-{Nummer}`), optional jährlich neu beginnend.
- Eingestellt: [[Schema und Startnummern je Nummernkreis]].

## 3.5 E-Rechnung

- Ausgang: jede Rechnung als ZUGFeRD EN 16931 (XML im PDF/A-3), bei Leitweg-ID oder Kundenwunsch zusätzlich XRechnung (UBL oder CII). Prüfung mit dem KoSIT-Validator vor dem Festschreiben; XML und Prüfbericht werden archiviert.
- Eingang: Lesen von ZUGFeRD/Factur-X und XRechnung (UBL/CII), Prüfung mit KoSIT als Hinweis.

## 3.6 Schnittstellen und Datenträgerüberlassung

| Export | Inhalt | Zweck |
|---|---|---|
| DATEV-Buchungsstapel (EXTF) | Ausgangsrechnungen, Zahlungen, anerkannte Kürzungen, bestätigte Eingangsrechnungen, Belege | Steuerberatung |
| GoBD-Export (Z3) | Tabellen als CSV mit `index.xml` (Beschreibungsstandard), Belege | Datenträgerüberlassung bei der Außenprüfung |
| Vollexport | alle Daten der Firma | Datensicherung, Programmwechsel |

Mittelbarer (Z2) und unmittelbarer Zugriff (Z1): befristeter Prüferzugang mit Leserechten (siehe 4.5).

## 3.7 Datenhaltung und Mandanten

Mehrere Firmen auf einer Installation sind auf Datenbankebene getrennt (Row Level Security); die Anwendung arbeitet mit einem eingeschränkten Datenbankbenutzer ohne Recht, diese Trennung zu umgehen. Beträge werden als ganze Cent gespeichert, Steuern je Steuersatz auf Summenebene kaufmännisch gerundet.
