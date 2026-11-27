# ADR 0010: Offline-Betrieb auf der Baustelle (PWA, Zwischenspeicher, Postausgang)

- Status: angenommen
- Datum: 2026-11-12
- Bezug: DESIGN.md §6 „Offline-Sync“, CLAUDE.md Regel 10 (Idempotenz) und Regel 11 (Formeln rechnet der Server)

## Kontext
Auf Baustellen gibt es oft kein oder nur schwaches Netz (Keller, Rohbau, Land). Aufmaß, Bautagebuch und Fotos müssen trotzdem erfasst werden können und später ohne Doppelungen beim Server ankommen. Finanzdokumente (Rechnungen, Festschreiben) bleiben bewusst online-only.

## Entscheidung
1. **Installierbare App (PWA)** mit `vite-plugin-pwa` (MIT): Manifest, Symbole und ein Service Worker, der nur die App-Hülle (HTML, JS, CSS, Bilder) vorhält. API-Antworten cached der Service Worker **nicht**.
2. **Daten auf dem Gerät in IndexedDB** über Dexie (Apache-2.0), Modul `apps/web/src/offline`:
   - `cache`: letzte Antwort der GET-Anfragen der Baustellen-Module (Projekte, Aufmaßblätter und abrechenbare Positionen, Bautagebuch, Berichtsvorlagen, Einheiten, Ordner, angemeldetes Konto). Allowlist in `isCacheable()`; Rechnungen, Kontakte, Einstellungen und Exporte werden nie gespeichert.
   - `outbox`: Änderungen ohne Netz, je mit eigenem Idempotency-Key, Konto (`owner`) und Ziel-Ressource.
   - Abmelden löscht den Zwischenspeicher; wartende Änderungen bleiben für dieses Konto und werden erst nach dessen nächster Anmeldung gesendet (Hinweis beim Abmelden).
3. **Änderungen über `mutate()`** (in `api.ts`): online sofort an den Server; ohne Netz – oder solange ältere Änderungen warten (Reihenfolge!) – in den Postausgang. Die Ansicht zeigt die Änderung sofort („noch nicht übertragen“). Solange zu einer Ressource Änderungen warten, liefert ein GET die lokale Kopie statt des älteren Serverstands.
4. **Übertragung** der Reihe nach bei „online“, alle 30 s und beim Wiederanzeigen der App (`flushOutbox()`):
   - Netzfehler oder 5xx/408/429: anhalten, später erneut.
   - 401: „Bitte neu anmelden“, nichts geht verloren.
   - Andere 4xx (z. B. Aufmaßblatt inzwischen unterschrieben, Bericht für den Tag existiert): Änderung bleibt mit Begründung sichtbar („Erneut versuchen“ oder „Verwerfen“), die lokale Kopie wird verworfen, damit wieder der Serverstand gilt.
5. **Keine Doppelungen**: Neue Aufmaßzeilen und Berichte bekommen ihre ID auf dem Gerät (`id` im Request); kommt dieselbe ID noch einmal, antwortet der Server mit dem aktuellen Stand statt eine zweite Zeile anzulegen. POSTs tragen zusätzlich den Idempotency-Key. Fotos werden in einem Schritt hochgeladen und am Bericht verknüpft (`POST /reports/:id/photos/upload`).
6. **Konflikte**: Aufmaßzeilen sind eigenständige Datensätze (paralleles Erfassen ohne Konflikt). Berichte werden abschnittsweise gespeichert – gesendet werden nur geänderte Abschnitte, je Abschnitt gilt die letzte Änderung; ohne `If-Match`. Mengen rechnet der Server neu; die Menge offline ist nur eine Vorschau mit derselben Domain-Regel.
7. **„Offline verfügbar machen“** am Projekt lädt Aufmaß und Bautagebuch (letzte 30 Berichte) vorab auf das Gerät.
8. **Background Sync** *(Nachtrag 2026-11-26)*: Eigener Service Worker `apps/web/src/sw.ts` (vite-plugin-pwa `injectManifest`, Workbox-Precaching wie vorher). Kommt eine Änderung in den Postausgang, meldet die App beim Browser eine Synchronisierung an (`registration.sync.register('easybau-outbox')`). Ist wieder Netz da, weckt der Browser den Service Worker – auch bei geschlossener App – und der sendet mit derselben `flushOutbox()` für das gespeicherte Konto (`meta.owner`, nach Abmelden leer → nichts wird gesendet). App-Tabs und Service Worker senden nie gleichzeitig (Web Locks, `exclusive()`); unterbrochen (noch offline, Server ausgelastet) → der Browser versucht es später erneut. Nur Chromium-Browser (Chrome/Edge, v. a. Android) unterstützen Background Sync; Safari/iOS und Firefox übertragen weiter beim Öffnen der App.

## Offline nicht möglich (bewusst)
Unterschreiben (gemeinsames Aufmaß, Bericht), PDFs, Mengenübernahme, Löschen von Berichten, Blättern und Fotos, alle Finanzdokumente. Diese Schaltflächen sind ohne Netz ausgeblendet (`useOnline()`). *Nachtrag 2026-11-25:* Neue Aufmaßblätter und Räume gehen inzwischen offline (eigene IDs vom Gerät wie bei Zeilen und Berichten).

## Folgen
- Kein neuer Container, keine neue Variable. Caddy liefert App-Hülle und Service Worker mit `Cache-Control: no-cache`, gehashte Dateien ein Jahr gecacht.
- Daten der Baustellen-Module liegen unverschlüsselt im Browser-Speicher des Geräts (wie bei jeder Web-App mit Offline-Modus). Schutz: Geräte-Sperre, Abmelden löscht den Zwischenspeicher, keine Finanzdaten, Sitzung nur im HttpOnly-Cookie.
- Service Worker brauchen HTTPS mit gültigem Zertifikat (im Betrieb über Caddy gegeben; mit selbstsigniertem Testzertifikat registriert der Browser ihn nicht – der Datenteil funktioniert trotzdem, solange die Seite geöffnet ist).
