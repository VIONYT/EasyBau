# ADR 0008: Revisionssicheres Belegarchiv mit S3 Object Lock (MinIO im Stack, externer S3 optional)

- Status: angenommen; **Punkt „MinIO im Stack“ ersetzt durch [ADR 0009](0009-belegarchiv-rustfs.md)** (RustFS). Alles andere (Object Lock, Outbox, Nachweis, Abgleich, externer S3) gilt weiter.
- Datum: 2026-11-10
- Ergänzt: ADR 0004 (Dateiablage, Punkt 4), ADR 0007 (E-Rechnung); setzt Regel 8 (WORM) und Regel 7 (keine Löschung vor Fristende) um

## Kontext
- **Was archiviert wird:** Festgeschriebene Belege müssen unveränderbar und bis zum Ende der Aufbewahrungsfrist (§ 147 AO, 10 Jahre ab Ende des Belegjahres) lesbar aufbewahrt werden (GoBD). Gemeint sind die Originale: PDF/A, ZUGFeRD-PDF, XRechnung-/CII-XML und der KoSIT-Prüfbericht.
- **Bisher:** Sie liegen als `document_artifact` (insert-only, SHA-256) im Volume `files`. Die Datenbank schützt die Metadaten, die Dateien selbst kann aber jeder mit Zugriff auf den Server ändern oder löschen.
- **Fragen aus der Liste:**
  - MinIO im Stack oder externer S3? Entscheidung: MinIO als Standard, externer S3 als Option.
  - MinIO veröffentlicht seit 2025 keine Community-Images mehr; `minio/minio` ist auf Docker Hub nicht mehr verfügbar.

## Entscheidung
1. **WORM per S3 Object Lock.**
   - Jedes Original wird in einen Bucket mit aktiviertem Object Lock geschrieben.
   - Modus `COMPLIANCE`, Aufbewahrung bis zum Ende des letzten Tages der Frist (`retainUntilOf`).
   - Bis dahin kann niemand die Version löschen oder überschreiben, auch kein Administrator. Die Integrationstests prüfen das gegen MinIO.
   - Beim Hochladen werden SHA-256 (`x-amz-checksum-sha256`) und MD5 mitgeschickt; der SHA-256 steht zusätzlich als Metadatum am Objekt.
2. **Eigener, kleiner S3-Client** in `packages/storage` statt des AWS-SDK.
   - Signature V4, getestet mit dem Testvektor der AWS-Testsuite.
   - Nur die nötigen Operationen.
   - Grund: Image-Größe und Abhängigkeiten; das SDK bringt mehrere Dutzend MB mit.
3. **Archivierung asynchron per Outbox, nicht in der Festschreibe-Transaktion.**
   - Das Festschreiben legt das Original wie bisher im Volume `files` ab (Arbeitskopie). Der Worker kopiert alle noch nicht archivierten Originale alle 30 Sekunden in den Bucket. Er nutzt dafür die `SECURITY DEFINER`-Funktion `pending_archive_artifacts`, nach dem Muster des E-Mail-Postausgangs.
   - **Grund:** Ein Upload in einer Transaktion, die danach scheitert, hinterließe ein gesperrtes, zehn Jahre unlöschbares Objekt ohne Beleg.
   - **Idempotent:** Ein bereits vorhandenes Objekt mit gleichem SHA-256 wird nur erfasst, nicht erneut hochgeladen.
   - **Fehler:** Fehlversuche werden mit wachsender Pause wiederholt (`artifact_archive_attempt`).
   - **Prüfungen vor dem Kopieren:** In einen Bucket ohne Object Lock wird nie geschrieben. Eine Arbeitskopie mit abweichender Prüfsumme wird nicht archiviert, sondern gemeldet.
4. **Nachweis in der Datenbank.**
   - `artifact_archive` (insert-only, Audit, RLS) hält Bucket, Schlüssel, Version, SHA-256, Sperrfrist und Modus.
   - Ein Trigger verlangt dieselbe Prüfsumme wie das Original und eine Sperrfrist nicht vor `locked_until`.
5. **Lesen mit Rückfall.** Auslieferung und Exporte lesen zuerst die Arbeitskopie. Fehlt sie (z. B. nach einer Wiederherstellung nur der Datenbank), kommt das Original aus dem Archiv.
6. **MinIO als Standard, aus dem Quellcode gebaut** (`docker/storage.Dockerfile`).
   - Release `RELEASE.2025-10-15T17-29-55Z` (AGPL-3.0), per Commit-Hash geholt; Go-Module über `go.sum` geprüft.
   - Läuft nur intern, ca. 60–200 MB RAM. Volume `archive-data`.
   - Die App legt den Bucket mit Object Lock beim ersten Start an (`ARCHIVE_S3_CREATE_BUCKET=true`).
   - Das unbetreute `bitnamilegacy`-Image wurde verworfen.
7. **Externer S3 als Option.**
   - `COMPOSE_FILE=compose.yaml:compose.external-s3.yaml` schaltet den MinIO-Dienst ab.
   - `ARCHIVE_S3_*` zeigt auf einen beliebigen S3-kompatiblen Dienst mit Object Lock (AWS, Hetzner, IONOS, Wasabi, Backblaze B2 …).
   - Der Bucket wird vom Betreiber mit Object Lock angelegt. Der Betriebs-Check zeigt, ob er erreichbar ist und Object Lock hat.
8. **Exporte enthalten die Belege.**
   - GoBD-Z3: Ordner `belege/` und Tabelle `belege.csv` mit SHA-256, Frist und Archivzeitpunkt in `index.xml`.
   - DATEV: auf Wunsch ZIP mit Buchungsstapel und PDF je Rechnung.
   - Vollexport: alle Originale.

## Konsequenzen
- **Neuer Dienst `storage`** mit Volume `archive-data`. **Neue Pflichtvariable `ARCHIVE_S3_SECRET_KEY`.**
- **Build-Ressourcen:** Der MinIO-Build kompiliert Go (einige Minuten, ca. 2 GB RAM beim Bauen). Deshalb gibt es vorgebaute Images (amd64/arm64) in der GitHub Container Registry (`.github/workflows/images.yml`: `edge` vom Hauptzweig nach grünem CI, Versionen und `latest` aus Release-Tags); Betreiber nutzen `docker compose pull`.
- **Schutzumfang des mitgelieferten MinIO:**
  - Er schützt gegen nachträgliche Änderung über die Anwendung und gegen versehentliches Löschen.
  - Er schützt nicht gegen den Verlust der Festplatte oder gegen jemanden, der das Volume direkt löscht.
  - Für echte Unabhängigkeit vom Server: externer S3 bei einem zweiten Anbieter.
  - Die tägliche Sicherung enthält weiterhin alle Arbeitskopien (Volume `files`).
- **Archiv-Abgleich (umgesetzt, Migration 0025):** Der Worker prüft jede Nacht die am längsten nicht geprüften archivierten Objekte per HEAD (vorhanden, SHA-256-Metadatum, Größe, Sperrfrist ≥ Fristende), jedes zehnte zusätzlich per Download und SHA-256. Fehlende oder beschädigte Objekte werden aus einer unveränderten Quelle neu geschrieben: Arbeitskopie, sonst das bisherige Archiv (`ARCHIVE_PREVIOUS_S3_*`, nur beim Umzug). Mit Object Lock entsteht dabei eine neue Version; die alte bleibt gesperrt. Jede Prüfung steht in `artifact_archive_check` (nur einfügen). Ein vollständiger Abgleich je Firma (`archive_verify_request`) läuft nach `infra/restore.sh` automatisch, auf Wunsch im Betriebs-Check oder für alle Firmen mit `infra/archive-reconcile.sh`; nach dem Update auf 0025 einmal als Ausgangsprüfung.
- **Umzug auf einen anderen S3 (umgesetzt):** neuen Bucket konfigurieren, bisherigen als `ARCHIVE_PREVIOUS_S3_*` angeben, vollständigen Abgleich starten. Die Objekte werden mit ihrer ursprünglichen Sperrfrist übernommen, nur wenn die SHA-256 stimmt (siehe docs/self-hosting, „Belegarchiv umziehen“).
- **Unumkehrbar:** Ein COMPLIANCE-Lock lässt sich nicht verkürzen. Testsysteme sollten `ARCHIVE_RETENTION_MODE=GOVERNANCE` oder einen eigenen Bucket nutzen.
