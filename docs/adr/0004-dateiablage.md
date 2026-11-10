# ADR 0004: Dateiablage im Dateisystem-Volume, Objektspeicher bleibt für das Archiv

- Status: angenommen
- Datum: 2026-11-08
- Ergänzt: ADR 0002 (Container `storage`)

## Kontext
Projekte brauchen eine Ablage für Pläne, Fotos, Verträge und Schriftverkehr. Laut DESIGN.md §3.5 sollten alle Dateien in MinIO liegen. MinIO braucht im Betrieb rund 150 MB RAM und einen weiteren Container. Revisionssicherheit (Object Lock, WORM) ist aber nur für festgeschriebene Belege nötig (Regel 8), nicht für Baustellenfotos oder Pläne. Diese Belege gibt es noch nicht.

## Entscheidung
1. Dateien der Projektablage liegen in einem **Docker-Volume `files`**, eingehängt unter `STORAGE_DIR` (Standard `/data/files`). Die Datenbank (Tabelle `file`) speichert Name, MIME-Typ, Größe, SHA-256 und den Schlüssel `<tenant>/files/<uuid>`.
2. Zugriff nur über die Schnittstelle `ObjectStore` (`packages/storage`): `receive` (streamen, zählen, hashen, Kopf für die Typprüfung), `commit`, `read`, `delete`. Schlüssel erzeugt immer der Server; Pfade aus Nutzereingaben gibt es nicht.
3. Uploads werden **gestreamt**, nie ganz in den Speicher geladen. Sie werden geprüft: Größe (`UPLOAD_MAX_MB`), erlaubte Endung und passender Inhalt (Magic Number). HTML, SVG und ausführbare Dateien sind nicht erlaubt. Ausgeliefert wird mit `nosniff`, eigener CSP und `Content-Disposition`.
4. Für das **WORM-Archiv** festgeschriebener Rechnungen (PDF/A-3, XRechnung) kommt später ein S3-Treiber derselben Schnittstelle mit Object Lock hinzu (MinIO im Stack oder externer S3). Diese Entscheidung fällt mit dem Modul „Festschreiben“. → Umgesetzt in [ADR 0008](0008-belegarchiv-worm.md): MinIO (aus dem Quellcode gebaut) oder externer S3, Archivierung durch den Worker.

## Konsequenzen
- Kein zusätzlicher Container im kompakten Profil; etwa 150 MB RAM weniger.
- API und Worker müssen dasselbe Volume sehen (beide Profile: gleiches `x-app`-Template in `compose.yaml`).
- Backups müssen das Volume `files` zusammen mit der Datenbank sichern; die Betriebsanleitung beschreibt das.
- Wird eine Datenbankzeile gelöscht, entfernt die API die Datei erst nach dem Commit. Schlägt das fehl, bleibt eine verwaiste Datei zurück (harmlos, ein Aufräumjob kann sie später entfernen). Umgekehrt entsteht nie ein Datenbankeintrag ohne Datei.
- Ein späterer Wechsel auf S3 für die Ablage ist möglich, ohne Datenbank oder Routen zu ändern.
