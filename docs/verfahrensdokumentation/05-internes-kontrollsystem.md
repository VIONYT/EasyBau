# 5. Internes Kontrollsystem (IKS)

Das IKS beschreibt die Kontrollen, die die Ordnungsmäßigkeit sichern (GoBD Rz. 100 ff.). EasyBau unterstützt sie technisch; welche Sie organisatorisch anwenden, legen Sie hier fest.

## 5.1 Zugriffsschutz

- Anmeldung mit persönlichem Konto (keine Sammelkonten), Passwort (argon2id), Sperre nach Fehlversuchen; zweiter Faktor (App oder Sicherheitsschlüssel) für Admins erzwungen [[für alle Personen vorgeschrieben: ja/nein]].
- Rollen (Rechte werden auf dem Server geprüft):

| Rolle | Darf | Vergeben an |
|---|---|---|
| Admin | alles, inkl. Benutzer und Einstellungen | [[…]] |
| Büroleitung | Belege, Festschreiben, Zahlungen, Mahnungen, Exporte, Einstellungen | [[…]] |
| Projektleitung | Projekte, Angebote, Aufmaß, Berichte | [[…]] |
| Teamleitung / Teammitglied (Baustelle) | Aufmaß, Bautagebuch, Fotos – ohne Preise und Forderungen | [[…]] |
| Steuerberatung / Prüfer | nur lesen, befristet | [[…]] |

- Ausscheidende Personen werden am letzten Arbeitstag deaktiviert durch [[…]]. Überprüfung der Berechtigungen [[halbjährlich]].

## 5.2 Kontrollen im Ablauf

| Kontrolle | Umsetzung | Häufigkeit / Verantwortlich |
|---|---|---|
| Pflichtangaben auf Rechnungen | automatische Prüfung vor dem Festschreiben (§ 14 UStG, E-Rechnung/KoSIT) | bei jedem Beleg |
| Abrechnung nur beauftragter Leistungen | Hinweis auf freie Positionen und nicht beauftragte Nachträge, Bestätigung nötig | bei jedem Beleg |
| Doppelte Eingangsrechnungen | Abweisung gleicher Dateien | automatisch |
| Sachliche/rechnerische Prüfung Eingangsrechnungen | „Prüfung bestätigen“ durch [[…]] | [[…]] |
| Offene Posten | Rechnungsliste mit Fälligkeiten, Mahnvorschläge | [[wöchentlich, …]] |
| Abstimmung mit der Buchhaltung | DATEV-Export ↔ Buchführung der Steuerberatung | [[monatlich]] |
| Audit-Kette | nächtliche Prüfung, Ergebnis im Betriebs-Check, E-Mail bei Problemen | automatisch, Kontrolle durch [[…]] |
| Belegarchiv | nächtlicher Abgleich, E-Mail bei Problemen | automatisch |
| Sicherung | täglich, E-Mail bei Problemen, Wiederherstellungstest | [[jährlich]] |

## 5.3 Abweichungen

Fehler und Störungen (z. B. fehlgeschlagene Sicherung, Ausfall, versehentlich falsch festgeschriebene Rechnung) werden dokumentiert: [[Wo? z. B. Störungsprotokoll mit Datum, Ursache, Maßnahme]].
