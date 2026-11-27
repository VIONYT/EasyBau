# ADR 0012: Belege nach Ablauf der Aufbewahrungsfrist anonymisieren

- Status: angenommen
- Datum: 2026-11-26
- Ergänzt: ADR 0008/0009 (Belegarchiv), Regel 2 und 7 in `CLAUDE.md`

## Kontext
Festgeschriebene Belege sind unveränderlich (Regel 2, DB-Trigger) und ihre Originale liegen gesperrt im WORM-Archiv (ADR 0008). Das ist nur so lange gerechtfertigt, wie die Aufbewahrungspflicht besteht (§ 147 AO, § 257 HGB). Danach verlangt die DSGVO (Art. 17), personenbezogene Daten zu löschen. Kontakte werden seit Migration 0039 nach Fristende automatisch anonymisiert. Die Belege selbst behalten aber Empfänger, Anschrift und Texte im Snapshot, in den Positionen, in Mahnungen, E-Mails, im Änderungsprotokoll und in den Original-PDFs.

Geprüfte Alternativen:
- **Belege ganz löschen** (Zeilen, Positionen, Zahlungen, Mahnungen): Lücken im Nummernkreis und in den Verknüpfungen (Abschläge in Schlussrechnungen, Zahlungen, Stornos). Dafür wären viele Trigger-Ausnahmen nötig.
- **Automatisch nachts löschen** wie bei Kontakten: Das Löschen ist endgültig. Ob eine Frist wirklich abgelaufen ist (z. B. Hemmung bei laufender Betriebsprüfung, § 147 Abs. 3 AO), weiß nur der Betrieb.
- **Eigener Löschschlüssel für das Archiv in der App**: Die App hätte dann ein Löschrecht im Belegarchiv. Object Lock würde zwar weiter schützen, aber der Grundsatz von ADR 0008 ginge verloren.

## Entscheidung (Nutzer, 2026-11-26)
1. **Anonymisieren statt löschen:** Nummer, Art, Datum, Beträge, Steuer, Status und Verknüpfungen bleiben. Ersetzt werden Empfänger-Snapshot (`Gelöschter Empfänger`, Kundennummer bleibt), Betreff, Leistungsort, Einleitungs-/Schlusstext, Stornogrund, Ansprechpartner und Positionstexte (`Gelöscht`). Ebenfalls ersetzt werden das Briefbild der Mahnungen (`letter_snapshot`) und Empfänger/Betreff/Text der zugehörigen E-Mails. Die Nutzdaten im Änderungsprotokoll (Version 2) werden geschwärzt.
2. **Liste und Freigabe:** „Prüfung › Aufbewahrung und Löschen nach Fristende“ listet fällige Belege. Eine Person mit `tenant.manage` gibt sie frei; jeder Beleg läuft in einer eigenen Transaktion (`purge_document()`). Das Löschprotokoll (`document_purge`, `artifact_purge`) bleibt dauerhaft als Nachweis und zeigt, wer wann was freigegeben hat und welche Originale noch zu löschen sind.
3. **Frist je Belegart:** Rechnungen und Gutschriften (Buchungsbelege) nutzen `tenant.retention_years` (Standard 10, mindestens 8 wegen BEG IV, einstellbar). Alle anderen Belege und Mahnungen (Handelsbriefe) nutzen 6 Jahre. Gezählt wird ab Ende des Belegjahres. Spätere Zahlungen, Kürzungen und Mahnungen verlängern die Frist. Die Sperrfrist archivierter Originale wird nie unterschritten (`document_retention_end()`). Neue Originale werden mit dieser Frist gesperrt (vorher pauschal 10 Jahre).
4. **Regel 2 bleibt Datenbank-Regel:** `document_immutable`, `guard_finalized_document_child` und die Mahnungs-Trigger erlauben genau eine Änderung. Bedingungen: Die Frist ist abgelaufen, eine Freigabe liegt vor, nur die genannten Spalten ändern sich, und es geschieht nur einmal (`purged_at`). Danach ist der Beleg wieder vollständig gesperrt. Für einen anonymisierten Beleg entstehen keine neuen Originale (Trigger).
5. **Originale:** Die Arbeitskopie löscht die App direkt nach der Freigabe. Die WORM-Kopie löscht der Betreiber mit `infra/archive-purge.sh`. Das Skript nutzt den Root-Schlüssel aus dem Volume `archive-keys` im Dienst `storage-setup` und entfernt alle Versionen. Der App-Zugang bekommt kein Löschrecht. Archivierung und Archiv-Abgleich überspringen anonymisierte Originale, damit nichts zurückgeschrieben wird.

## Konsequenzen
- Ein anonymisierter Beleg ist nur noch eine Zahlenzeile: Download, Druckansicht, E-Mail-Versand und Belege in Exporten entfallen (HTTP 410).
- Nicht abgedeckt (offen): Eingangsrechnungen und ihre Originale, Zahlungsnotizen, Bild-Positionen (Datei der Ablage), Ablage-Dateien und Berichte; Einträge im Änderungsprotokoll vor Migration 0042 (nicht schwärzbar); Sicherungen bis zu ihrem Ablauf.
- Bei externem S3 ohne `storage-setup` löscht der Betreiber mit den Werkzeugen des Anbieters und vermerkt es mit `archive_purge_done()`.

## Nachtrag 2026-11-27: Wiederherstellung (Migration 0052)

Eine ältere Sicherung enthält anonymisierte Belege und gelöschte Kontakte noch im alten Stand. Damit eine Wiederherstellung die Löschung nicht rückgängig macht, hinterlegt jede Anonymisierung und jede Kontaktlöschung eine Löschmarke (`erasure_marker`), die der Worker als kleines JSON (nur IDs, Freigabe, Datum) mit 10 Jahren Object Lock ins Belegarchiv schreibt. Das Archiv liegt außerhalb der Datenbank und wird nicht zurückgespielt. Beim Start des Workers und jede Nacht vor dem Archiv-Abgleich vergleicht er die Marken mit der Datenbank und wiederholt fehlende Anonymisierungen (mit der ursprünglichen Freigabe; die Frist prüft die Datenbank erneut) und Kontaktlöschungen. Ohne Belegarchiv gibt es keinen Ort außerhalb der Sicherung; dann bleibt es beim Wiederholen von Hand.
