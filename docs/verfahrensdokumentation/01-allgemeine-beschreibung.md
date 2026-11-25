# 1. Allgemeine Beschreibung

## 1.1 Unternehmen

| | |
|---|---|
| Firma, Rechtsform | [[Muster Bau GmbH]] |
| Anschrift | [[Straße, PLZ Ort]] |
| Steuernummer / USt-IdNr. | [[…]] |
| Gewerk, Tätigkeit | [[z. B. Maler- und Trockenbauarbeiten, überwiegend für Privat- und Gewerbekunden]] |
| Mitarbeitende | [[Anzahl Büro / Baustelle]] |
| Steuerberatung | [[Kanzlei, Ansprechpartner]] – erhält monatlich den DATEV-Export |

## 1.2 Zuständigkeiten

| Aufgabe | Zuständig | Vertretung |
|---|---|---|
| Gesamtverantwortung Verfahrensdokumentation | [[Inhaber/Geschäftsführung]] | |
| Angebote, Aufträge, Rechnungen, Festschreiben | [[Büroleitung]] | [[…]] |
| Eingangsrechnungen prüfen und bestätigen | [[…]] | [[…]] |
| Zahlungen erfassen, Mahnwesen | [[…]] | [[…]] |
| Betrieb des Servers, Updates, Sicherung | [[IT-Dienstleister oder Person]] | [[…]] |
| Benutzer und Rechte verwalten | [[Admin]] | [[…]] |

## 1.3 Eingesetzte Programme

| Programm | Zweck | Version / Betrieb |
|---|---|---|
| **EasyBau** (Open Source, AGPL-3.0) | Kontakte, Projekte, Angebote, Aufträge, Aufmaß, Bautagebuch, Rechnungen inkl. E-Rechnung, Zahlungen, Mahnungen, Eingangsrechnungen, Exporte | [[Version, z. B. v0.1.0]], selbst betrieben auf [[Server/Standort]] |
| DATEV (bei der Steuerberatung) | Finanzbuchhaltung | Import des EasyBau-Buchungsstapels |
| [[E-Mail-Server/Anbieter]] | Versand von Dokumenten und Mahnungen, Rechnungseingang per E-Mail | [[…]] |
| [[Bank/Online-Banking]] | Zahlungsverkehr (nicht an EasyBau angebunden) | |

EasyBau ist **keine Finanzbuchhaltung**: Es erzeugt die Ausgangsbelege, verwaltet Forderungen und Eingangsrechnungen und übergibt die Buchungsdaten per DATEV-Export an die Steuerberatung.

## 1.4 Überblick der Abläufe

```
Kontakt → Projekt → Angebot ─(fertig)→ Auftragsbestätigung ─→ Aufmaß / Bautagebuch / Regieberichte
                                                     │
                                  Nachträge (beauftragt) ┘
                                                     ↓
           Abschlags- / Teil- / Schlussrechnung ─(festschreiben: Nummer, E-Rechnung, Archiv)→ Versand
                                                     ↓
                       Zahlungen und Abzüge → Mahnwesen → DATEV-Export an die Steuerberatung

Eingangsrechnung (Upload oder E-Mail-Postfach) → Prüfung, Kostenzuweisung → bestätigen → DATEV-Export
```

Papierbelege: [[Werden Papierbelege gescannt? Wenn ja: Ablauf des ersetzenden Scannens beschreiben (wer, wann, wie geprüft, was mit dem Papier geschieht) – siehe Muster-Verfahrensdokumentation „Ersetzendes Scannen“ der Bundessteuerberaterkammer. Eingescannte Eingangsrechnungen werden in EasyBau als Original abgelegt.]]
