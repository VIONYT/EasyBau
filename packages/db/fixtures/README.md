# Datenbestände für den Upgrade-Test

`upgrade-NNNN.sql` ist ein Datenabzug (nur Daten, `INSERT`) einer Datenbank auf dem Stand der
Migration `NNNN`, erzeugt über die echte API: zwei Firmen, Kontakte, Stammdaten mit
DATANORM-Katalog, Angebot → Auftrag → Aufmaß → Abschlags-, Storno- und Schlussrechnung,
Zahlung, Zahlungserinnerung, teilbeauftragter Nachtrag, unterschriebenes Bautagebuch,
Eingangsrechnung mit Kostenzuweisung. Alle Daten sind erfunden.

`packages/db/src/upgrade.integration.test.ts` spielt jeden Abzug in eine Datenbank auf genau diesem
Stand ein, wendet alle neueren Migrationen an und prüft: keine Tabelle verliert Zeilen, die
Audit-Kette jeder Firma ist intakt, das Schema gleicht einer frisch migrierten Datenbank.

**Pflege:** Vorhanden: `upgrade-0037.sql`, `upgrade-0042.sql`, `upgrade-0052.sql` (Stand `v0.1.0`; mit pg_dump 16 erzeugt, reine Daten-INSERTs, unter PostgreSQL 17 identisch ladbar). Vor jedem Release einen Abzug des Release-Stands hinzufügen und ältere behalten,
solange Installationen von dort aus aktualisiert werden sollen:

```bash
DATABASE_URL=postgres://opc:opc@127.0.0.1:55432/opc PG_CONTAINER=opc-pg-schema \
  sh packages/db/fixtures/make-upgrade-fixture.sh
```

Ändert sich die API so, dass der Generator nicht mehr durchläuft, den Generator anpassen – die
vorhandenen Abzüge bleiben unverändert (sie stehen für bereits veröffentlichte Stände).
