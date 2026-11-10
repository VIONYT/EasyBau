# ADR 0007: E-Rechnung (ZUGFeRD/XRechnung) mit eigenem Generator und KoSIT-Validator als Container

- Status: angenommen
- Datum: 2026-11-10
- Ergänzt: ADR 0002 (schlanker Stack), ADR 0006 (PDF/A-3 mit Typst); setzt Regel 8 aus CLAUDE.md um

## Kontext
Seit 2025 müssen Betriebe E-Rechnungen empfangen können; ab 2027/2028 müssen sie im B2B-Geschäft E-Rechnungen ausstellen. Öffentliche Auftraggeber verlangen XRechnung mit Leitweg-ID. Regel 8: Jede E-Rechnung muss den KoSIT-Validator bestehen, bevor sie versendet oder archiviert wird.

Offen waren drei Fragen:
1. Mit welcher Bibliothek wird das XML erzeugt?
2. Wie läuft der KoSIT-Validator (Java) im Stack, ohne das Profil *kompakt* zu sprengen?
3. Wann wird geprüft: beim Versand oder schon beim Festschreiben?

## Entscheidung
1. **Eigenes Paket `packages/einvoice`** statt `@e-invoice-eu/core` (DESIGN.md, ursprünglicher Plan).
   - Dessen Lizenz (WTFPL) ist nicht OSI-anerkannt.
   - Es zieht große Abhängigkeiten nach sich (Excel-Leser, PDF-Bibliothek).
   - Unser Generator ist reine TypeScript-Logik ohne I/O.
     - Abbildung festgeschriebenes Dokument → EN 16931 (`einvoiceFromDocument`)
     - CII für ZUGFeRD/Factur-X Profil EN 16931 und XRechnung CII
     - UBL 2.1 für XRechnung (Invoice/CreditNote)
     - Factur-X-XMP-Erweiterung für das PDF
     - Auswertung des KoSIT-Prüfberichts
   - Die Werte werden nur escaped geschrieben, nie ausgewertet.
2. **ZUGFeRD in jeder Rechnung, XRechnung bei Bedarf.**
   - Jede Rechnung/Gutschrift enthält im PDF/A-3 die Datei `factur-x.xml` (CII, Profil EN 16931, AFRelationship *Alternative*).
   - Typst hängt die Datei an. Die Factur-X-XMP-Metadaten kommen als **inkrementelles PDF-Update** dazu: Die Originalbytes bleiben unverändert, PDF/A erlaubt das.
   - XRechnung (UBL, auf Wunsch CII) entsteht zusätzlich, wenn der Kontakt sie verlangt oder eine Leitweg-ID hat.
3. **Prüfung beim Festschreiben, in derselben Transaktion.** Ablauf beim Festschreiben:
   - Nummer vergeben und Snapshots anlegen.
   - Daraus das XML erzeugen.
   - Jede Datei an KoSIT senden.
   - Nur wenn alle Dateien bestehen, werden XML und Prüfbericht als `document_artifact` (insert-only, SHA-256, Sperrfrist) abgelegt und die Transaktion bestätigt.
   - Lehnt KoSIT ab oder ist der Dienst nicht erreichbar, wird alles zurückgerollt: keine Nummer verbraucht, Rechnung bleibt Entwurf, verständliche Meldung (422 bzw. 503).
   - So gibt es nie eine Rechnungsnummer ohne gültige E-Rechnung. Versand und Archiv verwenden genau die geprüften Bytes.
   - Die Datenbank erzwingt zusätzlich: E-Rechnungs-Artefakte nur mit `validated_at` (Migration 0020).
4. **KoSIT als eigener Container `kosit`** (`docker/kosit.Dockerfile`).
   - Validator 1.6.3 und XRechnung-Konfiguration 3.0.2 (Release 2026-08-31), beide Apache-2.0, mit festen Versionen und SHA-256-Prüfsummen.
   - Läuft im Daemon-Modus, nur im internen Netz erreichbar.
   - Begrenzte JVM: `-Xmx256m`, Serial GC, C1-Compiler. Gemessen: ca. 300 MB RAM.
   - Läuft in **beiden Profilen dauerhaft**. Ein Start „bei Bedarf“ (DESIGN.md) hätte Zugriff der App auf den Docker-Socket verlangt. Das ist ein unvertretbares Sicherheitsrisiko (Root-Rechte auf dem Host).
   - Die App spricht ihn über `KOSIT_URL` an (Standard im Stack: `http://kosit:8080`).
5. **veraPDF/Mustang bleiben außerhalb des Stacks.**
   - Die erzeugten ZUGFeRD-PDFs wurden während der Entwicklung mit dem Mustang-Validator geprüft (PDF/A-3B per veraPDF und XML nach EN 16931: gültig).
   - Eine automatische Prüfung kann als optionaler CI-Schritt folgen.

## Konsequenzen
- Speicher im Profil *kompakt* steigt um ca. 300 MB. Gesamtbedarf bleibt im Rahmen eines Servers mit 2 GB (ADR 0002 nennt KoSIT bereits als Bestandteil).
- Ohne laufenden KoSIT können keine Rechnungen festgeschrieben werden; Angebote und andere Dokumente sind nicht betroffen. Der Betriebs-Check zeigt den Zustand des Dienstes.
- Integrationstests nutzen den echten KoSIT, sobald `KOSIT_URL` gesetzt ist (Docker-Testpipeline, CI). Ohne ihn (CI-Job ohne Docker) prüft ein als Platzhalter gekennzeichneter Stub. Die Beispielrechnungen in `packages/einvoice` werden in der Pipeline gegen KoSIT validiert:
  - Standard, Rabatt
  - Abschlag, Schlussrechnung mit Abzügen
  - § 13b, § 19
  - innergemeinschaftliche Leistung
  - Storno, Gutschrift
  - XRechnung UBL/CII
- Aktualisierung bei neuen XRechnung-Versionen: Version und Prüfsumme in `docker/kosit.Dockerfile` anpassen. Kennung (`xrechnung_3.0`) und Regeln in `packages/einvoice` prüfen.
- Sicherheitseinbehalt und Bauumlage kennt EN 16931 nicht als Abzug vom Zahlbetrag. Sie stehen als Hinweis in der E-Rechnung; der Rechnungsbetrag (BT-115) bleibt der Bruttobetrag. Fachlich mit dem Steuerberater bestätigen.
