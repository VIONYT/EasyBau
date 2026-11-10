# ADR 0006: PDF/A-3 mit Typst als Node-Bindung im App-Prozess

- Status: angenommen
- Datum: 2026-11-09
- Ergänzt: ADR 0002 (schlanker Stack: PDFs nur mit Typst, kein Chromium)

## Kontext
Festgeschriebene Belege brauchen ein unveränderliches, langzeitarchivierbares PDF (GoBD; später ZUGFeRD = PDF/A-3 mit eingebettetem XML). ADR 0002 legt Typst fest. Offen war, wie Typst in den Stack kommt: als CLI-Programm im Image (Download von GitHub oder Alpine-Paket), als eigener Container oder als Bibliothek im Node-Prozess.

## Entscheidung
1. Typst wird über die Node-Bindung **`@myriaddreamin/typst-ts-node-compiler`** (Apache-2.0, Typst 0.14) im App-Prozess genutzt. Sie kommt als npm-Abhängigkeit mit vorkompilierten Binärdateien für glibc und musl (Alpine) – kein zusätzlicher Download im Dockerfile, kein neuer Container, gleiche Ausgabe in Entwicklung, Tests und Betrieb.
2. Paket `packages/pdf-templates`: Typst-Vorlage `templates/letter.typ` (Brief nach DIN 5008 Form B, A4), Schriften im Paket (Inter, DejaVu Serif; Lizenzen in `fonts/`) – nie Systemschriften, damit jedes Dokument überall gleich aussieht. Alle Inhalte gehen als JSON in die Vorlage und werden als Text gesetzt, nie als Typst-Markup ausgewertet.
3. Ausgabe **PDF/A-3b** (Schriften eingebettet, XMP-Metadaten, getaggt). PDF/A-3 erlaubt später das Anhängen des E-Rechnungs-XML (ZUGFeRD).
4. Entwürfe werden bei jedem Abruf neu gerendert (Wasserzeichen „ENTWURF“). Ein festgeschriebenes Dokument wird direkt nach dem Festschreiben einmal gerendert und als `document_artifact` (Art `pdf`, SHA-256, Sperrfrist bis Ende des 10. Jahres nach dem Belegjahr) abgelegt; jeder spätere Abruf liefert genau dieses Original.

## Konsequenzen
- Rendern dauert etwa 80 ms je Dokument und blockiert in dieser Zeit den Event-Loop; für das kompakte Profil (1–10 Nutzer) unkritisch. Bei Bedarf kann das Rendern später in den Worker verlagert werden.
- Das App-Image wird um die Binärdatei der Bindung (rund 30 MB) und die Schriften (rund 2 MB) größer.
- Ablage zunächst im Volume `files`; das WORM-Archiv mit Object Lock (ADR 0004, Punkt 4) folgt und übernimmt dann die Artefakte.
- PDF/A-Konformität ist über die XMP-Kennung getestet; eine Prüfung mit veraPDF sollte vor dem Release ergänzt werden.
