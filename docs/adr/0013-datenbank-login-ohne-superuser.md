# ADR 0013: Eigener Datenbank-Login ohne Superuser für Anwendungsabfragen

Status: angenommen (2026-11-27, nach dem Sicherheitsaudit run-1)

## Kontext

Bisher meldete sich der Laufzeit-Pool mit dem Administrator aus `DATABASE_URL` an (im Compose-Stack
der PostgreSQL-Superuser) und wechselte per Startparameter `role=opc_app` auf die eingeschränkte
Rolle. Row Level Security griff damit zwar für jede Abfrage. Ein Fehler, der beliebiges SQL
zulässt, hätte aber mit `SET ROLE` oder `SET SESSION AUTHORIZATION` wieder Superuser werden können:
alle Firmen lesen, Trigger abschalten, festgeschriebene Belege ändern.

## Entscheidung

- Der Server legt beim Start (nach den Migrationen) einen eigenen Login `opc_runtime_<datenbank>` an
  bzw. aktualisiert ihn: `LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE`, Mitglied
  von `opc_app`, Recht `CONNECT` auf die Datenbank. Das Passwort wird per HMAC aus `APP_SECRET`
  abgeleitet. Betreiber stellen nichts ein, ein Wechsel von `APP_SECRET` setzt es beim nächsten Start neu.
- Anwendungsabfragen (`createSql`, Modus `runtime`) nutzen diesen Login und wechseln weiter auf `opc_app`.
  `DATABASE_URL` bleibt für Migrationen, die Job-Queue (pg-boss) und das Anlegen des Logins.
- Wer den Login selbst verwalten will oder dessen Administrator keine Rollen anlegen darf (externe
  Datenbank), setzt `DATABASE_RUNTIME_URL`. Scheitert das Anlegen, startet der Server trotzdem
  (wie bisher, mit Warnung im Log).

## Folgen

- Kein neuer Container, keine neue Pflichtvariable. Die Rolle gilt clusterweit; der Name enthält
  den Datenbanknamen, damit mehrere Installationen auf einem Cluster sich nicht stören.
- Die Job-Queue (pg-boss) hat seit 2026-11-27 ebenfalls einen eigenen Login `opc_jobs_<datenbank>`,
  Besitzer nur des Schemas `jobs` (bestehende Objekte werden beim Start übergeben), ohne Rechte auf
  Firmendaten; `DATABASE_JOBS_URL` überschreibt. Migrationen und das Anlegen der Logins bleiben
  beim Administrator aus `DATABASE_URL`.
