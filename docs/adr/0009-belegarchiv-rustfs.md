# ADR 0009: RustFS statt MinIO als mitgeliefertes Belegarchiv

- Status: angenommen
- Datum: 2026-11-11
- Ersetzt: den Punkt „MinIO im Stack“ aus [ADR 0008](0008-belegarchiv-worm.md). Object Lock (COMPLIANCE), Outbox, Nachweis `artifact_archive`, Archiv-Abgleich und externer S3 bleiben unverändert.

## Kontext
- **MinIO Community ist eingestellt.**
  - Seit Oktober 2025 gibt es keine Programme und Images mehr. Seit Dezember 2025 läuft das Projekt im Wartungsmodus.
  - Am 25.04.2026 wurde das GitHub-Repository archiviert („THIS REPOSITORY IS NO LONGER MAINTAINED“).
  - Gegen die letzte freie Version sind Sicherheitslücken veröffentlicht, die nicht mehr behoben werden.
  - Für ein Archiv, das mindestens zehn Jahre halten muss, ist ungepatchte Software keine Grundlage.
- **Anforderungen an den Ersatz:**
  - S3 mit Object Lock im Modus COMPLIANCE, der sich auch über interne Schnittstellen nicht umgehen lässt.
  - OSI-Lizenz, die zu AGPL passt.
  - Läuft im Profil *kompakt* (Server mit 2 GB).
  - Wird gepflegt.

## Bewertung (Test am 2026-11-11)
**Testaufbau:**
- `packages/storage/src/worm.integration.test.ts`: 12 Angriffe mit den Zugangsdaten der App, zusätzlich eine Prüfung nach einem Neustart.
- Unsere Archiv-, Abgleich- und API-Suiten (39 Tests).
- Last mit 1.000 gesperrten Originalen.
- Suche nach Umgehungen über interne Schnittstellen.

**Ergebnisse:**

| | MinIO (RELEASE.2025-10-15) | SeaweedFS 4.53 | RustFS 1.0.5 |
|---|---|---|---|
| 12 WORM-Angriffe, Neustart, 39 Archiv-Tests | bestanden | bestanden | bestanden |
| Umgehung über interne Schnittstelle | keine gefunden | **ja**: gesperrte Version per Filer-HTTP (ohne Anmeldung) und trotz JWT per `weed shell`/gRPC löschbar | keine gefunden |
| RAM Leerlauf / nach Last | 64 / 263 MB | 144 / 350 MB | 24 / 218 MB |
| Lizenz | AGPL-3.0 | Apache-2.0 | Apache-2.0 |
| Pflege | eingestellt | aktiv | aktiv |

**Ausgeschieden:**
- **Garage:** keine Versionierung, also kein Object Lock.
- **Versity Gateway:** Object Lock nur mit dem Dateisystem ScoutFS.
- **Ceph RGW:** zu schwer für das Kompakt-Profil.
- **AIStor:** nicht frei lizenziert.

## Entscheidung
1. **RustFS** wird der mitgelieferte Dienst `storage`.
   - Das Image des Herstellers für amd64 und arm64.
   - Fest gepinnt mit Tag und Digest (`RUSTFS_IMAGE`), kein `latest`.
   - Nur intern erreichbar, Healthcheck `/health/ready`.
2. **Der Root-Schlüssel erreicht die App nie.**
   - `storage-keys` erzeugt ihn beim ersten Start zufällig im Volume `archive-keys`. Nur die Archiv-Dienste binden dieses Volume ein.
   - `storage-setup` (`infra/storage/setup.sh`, idempotent, bei jedem Start) legt den Bucket mit Object Lock und Versionierung an. Dazu kommt die Richtlinie `belegarchiv-app` (`infra/storage/app-policy.json`).
   - Die App erhält einen eigenen Zugang (`ARCHIVE_S3_ACCESS_KEY`/`ARCHIVE_S3_SECRET_KEY`), der nur Folgendes darf: schreiben, lesen, Sperrfrist setzen und lesen, Bucket-Status lesen.
   - Nicht erlaubt sind: Löschen (auch keine Löschmarker), Bucket-Einstellungen ändern, weitere Buckets anlegen, die Admin-API nutzen. Das ist getestet in `app-key.integration.test.ts`.
   - Wer also App und Datenbank übernimmt, kann im Archiv nichts löschen.
3. **Umstieg bestehender Installationen automatisch** (Migration 0026).
   - Nach dem Update ist das RustFS-Archiv leer. Für jede Firma mit archivierten Originalen startet ein vollständiger Archiv-Abgleich (`archive_verify_request`, Grund `move`).
   - Der Abgleich schreibt alle Originale aus der Arbeitskopie mit ihrer ursprünglichen Sperrfrist in RustFS.
   - Das alte MinIO-Volume `archive-data` bleibt unangetastet. Fehlt eine Arbeitskopie, dient der alte MinIO als Quelle: Profil `legacy-minio` mit `ARCHIVE_PREVIOUS_S3_*` (ADR 0008).
4. **Absicherung gegen Regressionen bei Updates.**
   - Die WORM-Angriffs-Suite und der Test des App-Schlüssels laufen in der Docker-Testpipeline und in CI gegen genau die gepinnte RustFS-Version.
   - Ein Update von RustFS ist nur ein neuer Digest in `compose.yaml` und `compose.test.yaml` und muss diese Tests bestehen.

## Folgen
- **Positiv:**
  - Gepflegte Software mit Sicherheitsprozess (SECURITY.md, Meldungen über GitHub-Advisories).
  - Kein eigener Go-Build mehr.
  - Weniger RAM.
  - Ein Zugang mit geringsten Rechten für die App.
- **Risiko:**
  - RustFS ist jung und hatte viele Advisories, 2026 auch zu Object Lock: Force-Delete eines Buckets, Lock bei unlesbaren Metadaten, `PUT ?versionId=`. Alle sind in 1.0.5 behoben und durch unsere Tests abgedeckt.
  - Gegenmaßnahmen:
    - gepinnte Version, Updates nur nach grünen WORM-Tests;
    - Advisories beobachten (P3);
    - der nächtliche Archiv-Abgleich bemerkt gelöschte oder beschädigte Originale und stellt sie aus der Arbeitskopie wieder her.
- **Grenze aller selbst betriebenen Archive:** Root auf dem Server kann Daten auf der Platte zerstören. Wer davor geschützt sein will, nutzt einen externen S3-Anbieter mit COMPLIANCE-Modus (`compose.external-s3.yaml`).
