# 6. Datenschutz und Löschkonzept

## 6.1 Verzeichnis von Verarbeitungstätigkeiten (Art. 30 DSGVO) – Auszug für EasyBau

| | |
|---|---|
| Verantwortlicher | [[Firma, Anschrift, Vertretung]] |
| Datenschutzbeauftragte(r) | [[falls bestellt (ab 20 Personen, die ständig personenbezogene Daten verarbeiten): Name, Kontakt]] |

| Verarbeitung | Betroffene | Daten | Zweck / Rechtsgrundlage | Empfänger | Löschfrist |
|---|---|---|---|---|---|
| Kunden- und Lieferantenverwaltung | Kunden, Interessenten, Ansprechpartner, Lieferanten | Name, Anschrift, Kommunikationswege, Kunden-/Kreditorennummer, USt-IdNr., Leitweg-ID | Vertrag, Vertragsanbahnung (Art. 6 Abs. 1 lit. b) | – | siehe 6.3 |
| Angebote, Aufträge, Rechnungen, Mahnungen | Kunden | wie oben, Leistungsort, Beträge, Zahlungen | Vertrag (lit. b), Aufbewahrung (lit. c i. V. m. § 147 AO, § 257 HGB) | Steuerberatung (DATEV-Export), Finanzverwaltung (Außenprüfung), E-Rechnungs-Plattformen | Rechnungen 10 Jahre, Handels- und Geschäftsbriefe 6 Jahre ab Ende des Kalenderjahres [[mit Steuerberatung bestätigen: Buchungsbelege seit 2025 8 Jahre]] |
| Eingangsrechnungen | Lieferanten, deren Ansprechpartner | Name, Anschrift, Bankverbindung, Rechnungsdaten | wie oben | Steuerberatung | 10 Jahre [[bzw. 8 Jahre, s. o.]] |
| Baustellendokumentation (Aufmaß, Bautagebuch, Fotos, Unterschriften) | Kunden, Mitarbeitende, ggf. Dritte auf Fotos | Namen, Unterschriften, Fotos, Arbeitszeiten je Bericht | Vertrag, Beweissicherung (lit. b, f) | Auftraggeber | [[z. B. Ende der Gewährleistung (5 Jahre nach Abnahme) bzw. Aufbewahrung, wenn abrechnungsrelevant]] |
| Benutzerkonten | Mitarbeitende, Steuerberatung | Name, E-Mail, Anmeldedaten, zweiter Faktor, Änderungsprotokoll | Arbeitsverhältnis / Zugriffsschutz (§ 26 BDSG, lit. c, f) | – | [[Deaktivierung bei Austritt; Protokolleinträge wie die Belege]] |
| E-Mail-Versand | Empfänger | Adresse, Betreff, Zeitpunkt (Inhalt wird nach dem Versand gelöscht) | Vertrag | [[E-Mail-Anbieter]] | [[…]] |

## 6.2 Technische und organisatorische Maßnahmen (Art. 32 DSGVO)

| Schutzziel | Durch EasyBau | Durch Sie |
|---|---|---|
| Zutritt / Zugang | Anmeldung mit argon2id-Passwörtern, Sperre nach Fehlversuchen, zweiter Faktor (für Admins Pflicht), Sitzung nur im HttpOnly-Cookie | Serverraum/Rechenzentrum: [[…]]; Server-Zugang nur per SSH-Schlüssel: [[…]] |
| Zugriff | Rollen und Rechte serverseitig geprüft; Baustellenrollen ohne Preise und Forderungen; Prüferzugang befristet | Rechtevergabe nach Bedarf, Überprüfung [[…]] |
| Trennung | Mandantentrennung in der Datenbank (Row Level Security) | – |
| Weitergabe | Nur HTTPS (Caddy, automatische Zertifikate); Sicherung außer Haus verschlüsselt (restic) | sichere Übergabe der Exporte an die Steuerberatung: [[…]] |
| Eingabe / Nachvollziehbarkeit | Änderungsprotokoll mit Hash-Kette, nächtliche Prüfung | – |
| Verfügbarkeit | tägliche Sicherung mit Prüfsummen, Kopie außer Haus, WORM-Belegarchiv mit Abgleich, E-Mail-Warnung bei Problemen | USV, Überwachung, Wiederherstellungstest [[…]] |
| Datenschutzfreundliche Voreinstellungen | keine Telemetrie, externe Dienste (E-Mail, Postfach, Wetter) standardmäßig aus | – |

Auftragsverarbeiter (Art. 28 DSGVO), mit denen ein AV-Vertrag nötig ist: [[Hosting-Anbieter des Servers, Anbieter des S3-Speichers/Sicherungsziels, E-Mail-Anbieter, IT-Dienstleister]]. Die Steuerberatung ist in der Regel kein Auftragsverarbeiter.

## 6.3 Löschkonzept

**Grundsatz:** Personenbezogene Daten werden gelöscht, sobald der Zweck erfüllt ist und keine Aufbewahrungspflicht mehr besteht (Art. 17). Solange Belege aufbewahrt werden müssen, werden die zugehörigen Daten **gesperrt** statt gelöscht (Art. 17 Abs. 3 lit. b, Art. 18; § 147 AO, § 257 HGB).

### Kontakte (Kunden, Interessenten, Lieferanten) – in EasyBau umgesetzt

| Fall | Vorgehen in EasyBau |
|---|---|
| Kontakt steht in keinem festgeschriebenen Beleg (z. B. Interessent ohne Auftrag) | **Löschen (DSGVO)** im Kontakt anonymisiert sofort: Name, Anschriften, Kommunikationswege, Notizen, Verknüpfungen werden gelöscht. |
| Kontakt steht in festgeschriebenen Belegen oder Eingangsrechnungen | **Sperre bis Fristende**: Ende = spätestes Aufbewahrungsende der archivierten Originale, in denen der Kontakt steht (bzw. Jahresende + Aufbewahrungsjahre der Firma). Gesperrte Kontakte sind nicht änder- und nicht mehr für neue Projekte/Dokumente verwendbar. |
| Sperrfrist abgelaufen | Der Hintergrunddienst anonymisiert den Kontakt am Folgetag automatisch (täglich 05:07 Uhr). |
| Auskunft (Art. 15) / Datenübertragbarkeit (Art. 20) | **Auskunft herunterladen** im Kontakt: alle gespeicherten Daten als Datei; die Auskunft wird im Änderungsprotokoll vermerkt. |

Wer Löschungen und Auskünfte bearbeitet: [[…]]. Frist für die Antwort: ein Monat (Art. 12 Abs. 3).

### Was EasyBau (noch) nicht automatisch löscht – manuell regeln

- **Festgeschriebene Belege** (Rechnungen, Angebote, Mahnungen) mit ihren Empfängerdaten: nach Ablauf der Aufbewahrungsfrist löschen EasyBau und das WORM-Archiv sie nicht von selbst. [[Vorgehen festlegen, z. B. jährliche Prüfung; technische Unterstützung ist geplant.]]
- **Änderungsprotokoll**: Einträge zu Stammdaten enthalten den alten und neuen Stand (auch Namen und Anschriften) und sind Teil der GoBD-Nachvollziehbarkeit; sie bleiben bestehen, auch wenn der Kontakt anonymisiert wird. Eine Kürzung alter Protokollteile nach Fristende ist geplant.
- **Projekte, Baustellenanschriften, Ablage-Dateien, Fotos, Berichte** zu einem gelöschten Kunden: [[bei einer Löschung manuell prüfen, z. B. Projektname ohne Personennamen, Fotos löschen, soweit nicht abrechnungs- oder beweisrelevant]].
- **Benutzerkonten** ausgeschiedener Mitarbeitender: deaktivieren; Name bleibt in Protokollen und Unterschriften (Beweisfunktion).
- **Sicherungen**: Gelöschte Daten verschwinden aus den Sicherungen mit deren Ablauf ([[BACKUP_KEEP_DAYS]] Tage lokal, [[OFFSITE_KEEP_*]] außer Haus). Bei einer Wiederherstellung werden zwischenzeitliche Löschungen erneut ausgeführt: [[Vorgehen festlegen]].
