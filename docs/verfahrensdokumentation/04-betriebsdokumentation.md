# 4. Betriebsdokumentation

Technische Anleitung: [Betriebsdokumentation](../self-hosting/README.md). Hier wird festgehalten, **wie Sie den Betrieb organisiert haben**.

## 4.1 Server

| | |
|---|---|
| Standort / Anbieter | [[z. B. eigener Server im Büro, Rechenzentrum, Anbieter, Land]] |
| Betriebssystem, Docker-Version | [[…]] |
| Profil | [[kompakt / standard]] |
| Adresse der Anwendung | [[https://…]] |
| Zugang zum Server | [[wer, wie (SSH-Schlüssel), Protokollierung]] |

## 4.2 Updates

- Updates werden eingespielt von [[…]] in der Regel [[monatlich / bei Sicherheitsupdates sofort]] nach Lesen des Changelogs.
- Vor jedem Update: aktuelle Sicherung vorhanden (Betriebs-Check). Datenbank-Migrationen laufen beim Start automatisch und sind vorwärtskompatibel; veröffentlichte Migrationen werden nie geändert (geprüft in der CI des Projekts).
- Versionswechsel werden hier dokumentiert:

| Datum | von → auf | durch | Bemerkung |
|---|---|---|---|
| [[…]] | [[…]] | [[…]] | |

## 4.3 Datensicherung

- Täglich um [[BACKUP_TIME]]: Datenbank und Ablage als Sicherung mit Prüfsummen im Volume `backups`; Aufbewahrung [[BACKUP_KEEP_DAYS laut .env, Standard 14 Tage]].
- **Außer Haus:** verschlüsselte Kopie mit restic nach [[Ziel, z. B. REST-Server mit Löschsperre bei …]]; Passwort des Repositorys verwahrt bei [[…]] (getrennt vom Server).
- Belegarchiv: zusätzlich unveränderliche Kopie jedes Originals im WORM-Bucket [[Anbieter/Standort]].
- Die `.env` (insbesondere `APP_SECRET`) ist gesichert bei [[…]].

## 4.4 Wiederherstellung und Test

- Wiederherstellung mit `infra/restore.sh`, danach vollständiger Archiv-Abgleich.
- **Wiederherstellungstest** mindestens [[jährlich]] auf einem Testsystem; Ergebnis hier festhalten:

| Datum | Sicherung vom | Ergebnis | durch |
|---|---|---|---|
| [[…]] | [[…]] | [[…]] | [[…]] |

## 4.5 Überwachung und Prüferzugang

- Betriebs-Check unter Einstellungen › Betrieb (Sicherung, Kopie außer Haus, E-Mail, E-Rechnung, Audit-Kette, Belegarchiv, HTTPS, zweiter Faktor).
- Bei Problemen mit Sicherung, Audit-Kette oder Belegarchiv geht morgens eine E-Mail an alle mit dem Recht „Einstellungen ändern“ (eingerichteter E-Mail-Versand vorausgesetzt).
- Außenprüfung: Prüferzugang (Rolle „Steuerberatung / Prüfer“, nur lesen) mit Ablaufdatum, angelegt von [[Admin]]; Datenträgerüberlassung über den GoBD-Export.
