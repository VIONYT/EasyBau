-- 0005 Default data for a new company (called by the setup wizard inside the tenant context).
-- Idempotent: running it twice does not duplicate anything.

CREATE OR REPLACE FUNCTION seed_tenant_defaults() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  t uuid := current_tenant_id();
BEGIN
  IF t IS NULL THEN
    RAISE EXCEPTION 'seed_tenant_defaults requires app.tenant_id' USING ERRCODE = 'P0001';
  END IF;

  -- Units (DESIGN.md §4.2.1) with UN/ECE Rec. 20/21 codes for e-invoices.
  INSERT INTO unit (tenant_id, symbol, name, dimension, unece_code, decimals, aliases, is_system) VALUES
    (t, 'm',     'Meter',            'length',    'MTR', 2, '{}',            true),
    (t, 'Lfm',   'Laufender Meter',  'length',    'LM',  2, '{lfm,lfdm}',    true),
    (t, 'km',    'Kilometer',        'length',    'KMT', 2, '{}',            true),
    (t, 'm²',    'Quadratmeter',     'area',      'MTK', 2, '{m2,qm}',       true),
    (t, 'm³',    'Kubikmeter',       'volume',    'MTQ', 3, '{m3,cbm}',      true),
    (t, 'l',     'Liter',            'volume',    'LTR', 2, '{L,ltr}',       true),
    (t, 'kg',    'Kilogramm',        'mass',      'KGM', 2, '{}',            true),
    (t, 't',     'Tonne',            'mass',      'TNE', 3, '{to}',          true),
    (t, 'min',   'Minute',           'time',      'MIN', 0, '{Min.}',        true),
    (t, 'Std',   'Stunde',           'time',      'HUR', 2, '{Std.,h}',      true),
    (t, 'Wo.',   'Woche',            'time',      'WEE', 1, '{Wo,Woche}',    true),
    (t, 'pa',    'per annum (pro Jahr)', 'time',  'ANN', 2, '{p.a.}',        true),
    (t, 'Stk.',  'Stück',            'count',     'H87', 0, '{Stk,St.,St}',  true),
    (t, 'Pkg',   'Packung',          'container', 'XPK', 0, '{Pkg.}',        true),
    (t, 'Eimer', 'Eimer',            'container', 'XBJ', 0, '{}',            true),
    (t, 'Sack',  'Sack',             'container', 'XSA', 0, '{}',            true),
    (t, 'Rolle', 'Rolle',            'container', 'XRO', 0, '{}',            true),
    (t, 'Tube',  'Tube',             'container', 'XTU', 0, '{}',            true),
    (t, 'psch',  'Pauschal',         'lump_sum',  'LS',  0, '{psch.,pauschal}', true),
    (t, 'kWp',   'Kilowatt Peak',    'power',     'KWT', 2, '{KWp}',         true)
  ON CONFLICT (tenant_id, symbol) DO NOTHING;

  -- Number sequences (DESIGN.md §7.4).
  INSERT INTO number_sequence (tenant_id, kind, prefix, start_value, min_length, next_value) VALUES
    (t, 'contact',            'K-',  10001, 5, 10001),
    (t, 'project',            'P-',  101,   5, 101),
    (t, 'quote',              'A-',  101,   5, 101),
    (t, 'cost_estimate',      'KV-', 101,   5, 101),
    (t, 'order_confirmation', 'AB-', 101,   5, 101),
    (t, 'delivery_note',      'LS-', 101,   5, 101),
    (t, 'invoice',            'R-',  101,   5, 101),
    (t, 'credit_note',        'G-',  101,   5, 101)
  ON CONFLICT (tenant_id, kind) DO NOTHING;

  -- System roles (DESIGN.md §5.2). Permission keys are checked server-side.
  INSERT INTO role (tenant_id, key, name, access, is_system, permissions) VALUES
    (t, 'admin', 'Admin', 'office', true, ARRAY[
      'tenant.manage', 'users.manage', 'roles.manage', 'subscription.manage',
      'settings.read', 'settings.write', 'project.read_all', 'project.write', 'project.archive',
      'contacts.read', 'contacts.write', 'catalog.read', 'catalog.write', 'price.view',
      'document.read', 'document.write', 'document.finalize', 'document.cancel',
      'measurement.write', 'report.write', 'report.sign', 'files.read_all', 'files.share',
      'chat.delete_others', 'time.own', 'time.others', 'incoming_invoice.read', 'incoming_invoice.write',
      'payment.write', 'dunning.write', 'export.run', 'audit.read']),
    (t, 'office_lead', 'Büroleitung', 'office', true, ARRAY[
      'settings.read', 'settings.write', 'project.read_all', 'project.write', 'project.archive',
      'contacts.read', 'contacts.write', 'catalog.read', 'catalog.write', 'price.view',
      'document.read', 'document.write', 'document.finalize', 'document.cancel',
      'measurement.write', 'report.write', 'report.sign', 'files.read_all', 'files.share',
      'chat.delete_others', 'time.own', 'time.others', 'incoming_invoice.read', 'incoming_invoice.write',
      'payment.write', 'dunning.write', 'export.run', 'audit.read']),
    (t, 'project_lead', 'Projektleitung', 'office', true, ARRAY[
      'settings.read', 'project.write', 'contacts.read', 'contacts.write', 'catalog.read', 'price.view',
      'document.read', 'document.write', 'measurement.write', 'report.write', 'report.sign',
      'files.share', 'time.own', 'time.others', 'incoming_invoice.read']),
    (t, 'team_lead', 'Teamleitung (Baustelle)', 'site', true, ARRAY[
      'contacts.read', 'catalog.read', 'measurement.write', 'report.write', 'report.sign',
      'time.own', 'time.team']),
    (t, 'team_member', 'Teammitglied (Baustelle)', 'site', true, ARRAY[
      'measurement.write', 'report.write', 'time.own']),
    (t, 'auditor', 'Steuerberatung / Prüfer (nur lesen)', 'readonly', true, ARRAY[
      'project.read_all', 'contacts.read', 'document.read', 'files.read_all', 'export.run', 'audit.read'])
  ON CONFLICT (tenant_id, key) DO NOTHING;

  INSERT INTO surcharge (tenant_id, cost_kind, percent)
  SELECT t, k, 0 FROM unnest(ARRAY['labor', 'material', 'equipment', 'subcontract', 'other']) AS k
  ON CONFLICT DO NOTHING;

  IF NOT EXISTS (SELECT 1 FROM payment_term WHERE tenant_id = t) THEN
    INSERT INTO payment_term (tenant_id, name, due_days, is_default)
      VALUES (t, '7 Tage ohne Abzug', 7, true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM tax_rate WHERE tenant_id = t) THEN
    INSERT INTO tax_rate (tenant_id, name, percent, category_code, is_default) VALUES
      (t, 'Regelsteuersatz 19 %', 19, 'S', true),
      (t, 'Ermäßigt 7 %', 7, 'S', false),
      (t, 'Steuerschuldnerschaft des Leistungsempfängers (§ 13b UStG)', 0, 'AE', false),
      (t, 'Steuerfrei', 0, 'E', false),
      (t, 'Nullsteuersatz (§ 12 Abs. 3 UStG, z. B. Photovoltaik)', 0, 'Z', false);
  END IF;

  INSERT INTO project_status (tenant_id, key, label, color, sort, is_closed) VALUES
    (t, 'lead',        'Erstkontakt',       '#F28C28', 10, false),
    (t, 'survey',      'Besichtigung / Aufmaß', '#B45309', 20, false),
    (t, 'quoted',      'Angebot',           '#1D4ED8', 30, false),
    (t, 'ordered',     'Auftrag',           '#0F4C5C', 40, false),
    (t, 'in_progress', 'In Ausführung',     '#15803D', 50, false),
    (t, 'invoiced',    'Abgerechnet',       '#475569', 60, false),
    (t, 'closed',      'Abgeschlossen',     '#334155', 70, true)
  ON CONFLICT (tenant_id, key) DO NOTHING;

  INSERT INTO working_hours (tenant_id, weekday, start_time, end_time, break_minutes)
  SELECT t, d, '07:00', CASE WHEN d = 5 THEN '13:00'::time ELSE '16:00'::time END, 30
    FROM generate_series(1, 5) AS d
  ON CONFLICT DO NOTHING;

  -- Report templates (DESIGN.md §4.5). Section types: header, text, checklist, staff, services,
  -- materials, equipment, measurement, weather, photos, signatures, yes_no, deadline.
  INSERT INTO report_template (tenant_id, key, name, billable, is_system, sections) VALUES
    (t, 'daily_site_report', 'Bautagesbericht', true, true,
      '[{"id":"header","type":"header"},{"id":"weather","type":"weather"},{"id":"staff","type":"staff","transferTimes":true},
        {"id":"services","type":"services"},{"id":"materials","type":"materials"},{"id":"equipment","type":"equipment"},
        {"id":"incidents","type":"text","label":"Besondere Vorkommnisse","actions":["obstruction_notice","change_order"]},
        {"id":"photos","type":"photos"},{"id":"signatures","type":"signatures","roles":["contractor"]}]'),
    (t, 'daywork_report', 'Regiebericht', true, true,
      '[{"id":"header","type":"header","servicePeriod":true},{"id":"staff","type":"staff","transferTimes":true},
        {"id":"services","type":"services"},{"id":"materials","type":"materials"},{"id":"equipment","type":"equipment"},
        {"id":"photos","type":"photos"},{"id":"notes","type":"text","label":"Weitere Anmerkungen"},
        {"id":"signatures","type":"signatures","roles":["contractor","client"]}]'),
    (t, 'service_report', 'Einsatzbericht', true, true,
      '[{"id":"header","type":"header"},{"id":"staff","type":"staff","transferTimes":true},{"id":"services","type":"services"},
        {"id":"materials","type":"materials"},{"id":"photos","type":"photos"},{"id":"notes","type":"text","label":"Weitere Anmerkungen"},
        {"id":"signatures","type":"signatures","roles":["contractor","client"]}]'),
    (t, 'acceptance_protocol', 'Abnahmeprotokoll', true, true,
      '[{"id":"header","type":"header"},{"id":"accepted","type":"yes_no","label":"Leistung abgenommen"},
        {"id":"defects","type":"text","label":"Mängel"},{"id":"reservations","type":"text","label":"Vorbehalte"},
        {"id":"deadline","type":"deadline","label":"Frist zur Mängelbeseitigung"},{"id":"photos","type":"photos"},
        {"id":"signatures","type":"signatures","roles":["contractor","client"]}]'),
    (t, 'measurement_report', 'Aufmaß', false, true,
      '[{"id":"header","type":"header"},{"id":"measurement","type":"measurement","linkedSheet":true},
        {"id":"signatures","type":"signatures","roles":["contractor","client"]}]'),
    (t, 'concern_notice', 'Bedenkenanzeige gemäß VOB/B § 4 Abs. 3', false, true,
      '[{"id":"header","type":"header"},{"id":"concern","type":"text","label":"Bedenken"},
        {"id":"proposal","type":"text","label":"Vorschlag"},{"id":"deadline","type":"deadline","label":"Antwortfrist"},
        {"id":"photos","type":"photos"},{"id":"delivery","type":"text","label":"Zugang (Datum, Weg, Empfänger)"}]'),
    (t, 'obstruction_notice', 'Behinderungsanzeige gemäß VOB/B § 6 Abs. 1', false, true,
      '[{"id":"header","type":"header"},{"id":"obstruction","type":"text","label":"Behinderung"},
        {"id":"impact","type":"text","label":"Auswirkungen auf Ablauf und Kosten"},{"id":"photos","type":"photos"},
        {"id":"delivery","type":"text","label":"Zugang (Datum, Weg, Empfänger)"}]'),
    (t, 'site_inspection', 'Baustellenbegehung', false, true,
      '[{"id":"header","type":"header"},{"id":"checklist","type":"checklist"},
        {"id":"for_quote","type":"text","label":"Wichtig für die Angebotserstellung"},
        {"id":"measurement","type":"measurement"},{"id":"photos","type":"photos"},
        {"id":"notes","type":"text","label":"Weitere Anmerkungen"}]'),
    (t, 'meeting_minutes', 'Besprechungsprotokoll', false, true,
      '[{"id":"header","type":"header"},{"id":"participants","type":"text","label":"Teilnehmende"},
        {"id":"topics","type":"text","label":"Themen und Vereinbarungen"},{"id":"deadline","type":"deadline","label":"Nächste Frist"}]'),
    (t, 'checklist', 'Checkliste', false, true,
      '[{"id":"header","type":"header"},{"id":"checklist","type":"checklist"},{"id":"photos","type":"photos"}]'),
    (t, 'apprentice_log', 'Berichtsheft', false, true,
      '[{"id":"header","type":"header"},{"id":"activities","type":"text","label":"Tätigkeiten"},
        {"id":"lessons","type":"text","label":"Unterweisungen / Berufsschule"},{"id":"signatures","type":"signatures","roles":["other"]}]')
  ON CONFLICT (tenant_id, key) DO NOTHING;
END
$$;
