# ADR 0003: Datenbankschema als versionierte SQL-Migrationen

- Status: angenommen
- Datum: 2026-11-08
- Ändert: DESIGN.md §3.2 (bisher „Drizzle ORM + drizzle-kit“ für Migrationen)

## Kontext
Die wichtigsten Schutzregeln liegen in der Datenbank selbst:
- Row Level Security je Mandant (Regel 5)
- Trigger für die Unveränderbarkeit festgeschriebener Belege (Regeln 2 und 12)
- Audit-Log mit Hash-Kette (Regel 6)
- lückenlose Nummernkreise (Regel 3)

Ein ORM-Migrationsgenerator wie drizzle-kit erzeugt Tabellen gut, aber keine Policies, Trigger oder Funktionen. Ein Teil des Schemas läge dann außerhalb des Generators, und die Gefahr wäre groß, dass die beiden Quellen auseinanderlaufen. Außerdem müssen Migrationen beim Self-Hosting ohne Zutun des Betreibers sicher laufen.

## Entscheidung
1. Das Schema wird **ausschließlich als handgeschriebene, versionierte SQL-Dateien** gepflegt: `packages/db/migrations/NNNN_name.sql`. Sie laufen nur vorwärts.
2. Ein eigener, kleiner Runner (`packages/db/src/migrate.ts`):
   - serialisiert sich über einen Advisory Lock, sodass mehrere Container gleichzeitig starten dürfen;
   - führt jede Migration in einer eigenen Transaktion aus;
   - speichert eine SHA-256-Prüfsumme je Migration und **bricht ab, wenn eine bereits angewendete Migration verändert wurde**.
3. Migrationen laufen automatisch beim Start der API (`MIGRATE_ON_START=true`) mit dem Admin-Login. Manuell geht es mit `pnpm db:migrate`.
4. **Zwei Datenbankrollen**:
   - Der Admin-Login (`POSTGRES_USER`) führt Migrationen aus und betreibt die Job-Queue.
   - Alle Anwendungsabfragen laufen über die eingeschränkte Rolle `opc_app` (kein Superuser, kein `BYPASSRLS`). Die Verbindung wechselt per Startparameter `role` dorthin, ohne dass ein zweites Passwort nötig ist.
5. Der Mandantenkontext wird je Transaktion gesetzt: `withTenant()` → `set_config('app.tenant_id' / 'app.user_id', …, true)`.
6. Hilfsfunktionen sorgen dafür, dass neue Tabellen die Regeln einheitlich erfüllen: `enable_tenant_rls()`, `add_audit_trigger()`, `add_updated_at_trigger()` und `add_document_child_guard()`.
7. Typisierte Abfragen schreiben wir vorerst mit `postgres` (Tagged Templates, immer parametrisiert). Ein typisiertes Abfrage-Layer (z. B. Drizzle nur für Queries, per Introspektion aus der DB erzeugt) kann später ergänzt werden, ohne die Migrationen zu berühren.

## Regeln für neue Migrationen
- Eine veröffentlichte Migration wird nie geändert; Korrekturen kommen als neue Migration.
- Jede neue Fachtabelle bekommt `tenant_id` und `enable_tenant_rls()`. Steuerrelevante Tabellen bekommen zusätzlich `add_audit_trigger()`.
- Der Metatest „jede Tabelle mit `tenant_id` hat erzwungene RLS“ und der Test „keine Tabelle zeigt Zeilen eines anderen Mandanten“ laufen automatisch über alle Tabellen.
- Änderungen müssen vorwärtskompatibel sein (expand/contract), damit Updates ohne Ausfall möglich sind.

## Konsequenzen
- Das Schema ist lesbar an einer Stelle (SQL), inklusive aller Schutzmechanismen.
- Zur Laufzeit gibt es keine generierten TypeScript-Typen für Tabellen; Zod-Schemas in `packages/schemas` beschreiben die API-Verträge.
