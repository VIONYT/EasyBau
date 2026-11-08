# ADR 0002: Schlanker Stack für geringe Serverressourcen

- Status: angenommen
- Datum: 2026-11-08
- Ersetzt: ADR 0001, Punkt 3 (Valkey)

## Kontext
Das System läuft beim Betreiber (Self-Hosting). Es soll möglichst wenig Ressourcen brauchen und trotzdem schnell sein. Ziel: Ein kleiner Betrieb soll es auf einem Server mit 2 GB RAM betreiben können.

## Entscheidungen
1. **PostgreSQL 17 bleibt die Datenbank.** Mit Tuning für kleine Server braucht es 150–250 MB RAM. Es liefert RLS, Trigger, `FOR UPDATE` und PITR, auf die unsere Compliance-Regeln aufbauen, und ersetzt zugleich Queue, Sessions, Rate-Limits und Volltextsuche.
   - SQLite verworfen: keine RLS, nur ein Schreiber gleichzeitig, API und Worker als getrennte Prozesse wären problematisch, Schutzregeln müssten in der Anwendung nachgebaut werden.
   - MariaDB/MySQL verworfen: keine RLS, schwächere Trigger-, JSON- und Volltextfunktionen, kein Ressourcenvorteil.
2. **Warteschlange mit pg-boss in PostgreSQL** statt BullMQ/Valkey. Ein Container weniger, und Jobs werden transaktional mit der fachlichen Änderung angelegt (z. B. Festschreiben → PDF/E-Rechnung). Damit entfällt ein Ausfallrisiko zwischen Datenbank und Queue.
3. **Typst statt Chromium** für alle PDFs (Dokumente, Berichte, Mahnungen, Aufmaßblätter). Es spart 300–450 MB RAM und ist um Größenordnungen schneller. Das Ergebnis ist PDF/A-3b mit eingebetteter XML für ZUGFeRD. Die Qualität wird in CI mit veraPDF und KoSIT abgesichert. Vorlagen stehen in Typst-Markup; die Live-Vorschau kann dieselben Vorlagen per WebAssembly im Browser rendern.
4. **KoSIT-Validator mit begrenztem Speicher** (`-Xmx256m`). Im Profil „kompakt“ wird er bei Bedarf gestartet und bei Leerlauf beendet. Regel 8 (keine E-Rechnung ohne bestandene Prüfung) bleibt unverändert; während des Starts wartet der Job.
5. **Zwei Betriebsprofile**: `compact` (API und Worker in einem Prozess, ca. 1 GB RAM, Server mit 2 GB) und `standard` (getrennte Prozesse, ca. 1,5 GB RAM, Server mit 4 GB). Der Code ist so aufgebaut, dass beide Varianten aus demselben Image laufen (`ROLE=all|api|worker`).

## Konsequenzen
- Container im kompakten Profil: `proxy`, `app`, `db`, `storage`, `kosit` (bei Bedarf), `backup`.
- PDF-Vorlagen werden in Typst statt in HTML/CSS geschrieben. Das Designsystem (Farben, Schriften) wird als Typst-Variablen gespiegelt.
- CI testet beide Profile, das kompakte mit hartem Speicherlimit von 2 GB, und prüft Leistungsziele (API p95 < 200 ms, Rechnungs-PDF mit 100 Positionen < 1 s).
- Neue Container brauchen künftig eine eigene ADR mit Ressourcenbegründung.
