# 11. Exporte, Prüfung, Sicherheit

## Exporte für Steuerberater und Finanzamt

Unter **Prüfung › Exporte** (bzw. **Einstellungen**) für einen Zeitraum:

| Export | Inhalt |
|---|---|
| **DATEV** | Buchungsstapel für Ausgangsrechnungen, Zahlungen, Eingangsrechnungen, mit den Belegen (PDF/XML) |
| **GoBD (Z3)** | Datenträgerüberlassung für die Betriebsprüfung: Tabellen, `index.xml`, alle Belege |
| **Vollexport** | alle Daten der Firma als JSON plus alle Dateien der Ablage, z. B. für einen Umzug |

## Prüfung (Änderungsprotokoll)

Jede Änderung an steuerrelevanten Daten wird protokolliert – wer, wann, was vorher, was nachher – und mit einer Hash-Kette gegen nachträgliche Änderung gesichert. **Kette jetzt prüfen** prüft sofort; EasyBau prüft zusätzlich jede Nacht.

![Prüfung](../screenshots/macbook-pruefung.png)

### Zugang für Steuerberatung oder Betriebsprüfer

**Benutzer › Person einladen** mit der Rolle **Steuerberatung / Prüfer (nur lesen)** und einem Datum bei **Zugang bis** (höchstens ein Jahr). Der Prüfer sieht alles, ändert nichts und kann exportieren. Nach Ablauf endet der Zugang automatisch.

## Aufbewahrung und Löschen nach Fristende

Unter **Prüfung › Aufbewahrung und Löschen nach Fristende** stehen alle festgeschriebenen Belege, deren Aufbewahrungsfrist abgelaufen ist: Rechnungen und Gutschriften nach der eingestellten Frist (Standard 10 Jahre, mindestens 8 – mit dem Steuerberater klären), alle anderen Belege und Mahnungen nach 6 Jahren, jeweils ab Ende des Belegjahres. Administratoren wählen Belege aus und klicken **Belege anonymisieren …**:

- Nummer, Datum, Art und Beträge bleiben erhalten (der Nummernkreis bleibt lückenlos nachvollziehbar).
- Empfänger, Betreff, Texte, Positionsbeschreibungen, Mahnungsschreiben und E-Mails werden ersetzt; PDF und E-Rechnung werden gelöscht.
- Das ist **endgültig**. Vorher prüfen, ob die Frist gehemmt ist (z. B. laufende Betriebsprüfung).

Das **Löschprotokoll** darunter zeigt, wer wann welche Belege anonymisiert hat und ob noch Originale im Belegarchiv liegen. Diese löscht der Betreiber des Servers (siehe Betriebsanleitung, `archive-purge.sh`).

## Belegarchiv

Festgeschriebene Rechnungen, Mahnungen, E-Rechnungen, Eingangsrechnungen und fertige Angebote werden unveränderbar archiviert (WORM, gesperrt bis zum Ende der Aufbewahrungsfrist: Rechnungen, Gutschriften und Eingangsrechnungen nach der eingestellten Frist, alle anderen Belege 6 Jahre). An jedem Dokument steht „Original revisionssicher archiviert (unveränderbar bis …)“.

## Betriebs-Check

**Einstellungen › Betrieb** zeigt auf einen Blick, ob der Betrieb in Ordnung ist:

- **Sicherung** – letzte nächtliche Sicherung von Datenbank und Dateien,
- **Sicherung außer Haus** – verschlüsselte Kopie an einem zweiten Ort (sonst Warnung),
- **E-Mail-Versand**, **E-Rechnung (KoSIT)**, **Änderungsprotokoll**, **Belegarchiv** mit nächtlichem Abgleich,
- **HTTPS** und **Zwei-Faktor-Pflicht für Administratoren**.

Gelbe oder rote Einträge bitte an Ihren Administrator weitergeben.

![Betriebs-Check](../screenshots/macbook-betriebs-check.png)
