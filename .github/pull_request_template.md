## Worum geht es?

<!-- Was ändert sich und warum? Bezug zu einem Issue: „Closes #…“ -->

## Art der Änderung

- [ ] Fehlerbehebung
- [ ] Neue Funktion
- [ ] Betrieb (Container, Volume, Variable, Image)
- [ ] Dokumentation
- [ ] Wartung (Abhängigkeiten, Aufräumen, Tests)

## Wie wurde getestet?

- [ ] `pnpm lint && pnpm typecheck && pnpm test`
- [ ] Docker-Testpipeline (`docker compose -f compose.test.yaml run --rm --build test`)
- [ ] Neue/angepasste Tests (Rechenlogik in `packages/domain` mit 100 % Abdeckung)
- [ ] Oberfläche auf 375 px Breite und am Desktop geprüft (Screenshots unten)
- [ ] E2E (`pnpm test:e2e`), falls Kernabläufe betroffen

## Datenbank und Betrieb

- [ ] Keine Schemaänderung
- [ ] Neue Migration `packages/db/migrations/NNNN_….sql` (keine angewendete Migration geändert)
- [ ] Neue Tabelle mit `tenant_id`, RLS und Test „Mandant B sieht A nicht“
- [ ] Neue Einstellung in `.env.example` mit sicherem Standard
- [ ] `docs/self-hosting/` und `CHANGELOG.md` aktualisiert (bei Betriebsänderungen)

## Compliance (CLAUDE.md „Unverletzliche Regeln“)

- [ ] Beträge als Cent (`bigint`), keine Floats
- [ ] Festgeschriebene Dokumente, Zahlungen und Audit-Einträge bleiben unverändert (kein `UPDATE`/`DELETE`, Trigger unangetastet)
- [ ] Steuerrelevante Änderungen schreiben ein Audit-Ereignis
- [ ] Rechte werden serverseitig geprüft, Eingaben mit Zod validiert
- [ ] Keine Geheimnisse, keine echten Kundendaten, keine personenbezogenen Daten in Logs
- [ ] UI-Texte auf Deutsch über i18n-Schlüssel
- [ ] Nicht zutreffend (z. B. reine Doku)

## Screenshots

<!-- Bei Oberflächenänderungen: vorher/nachher, Handy und Desktop -->

## Offene Punkte

<!-- Was bleibt offen? Neue Erkenntnisse auch in CLAUDE.md „Offene Punkte nach Priorität“ eintragen. -->
