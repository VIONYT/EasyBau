-- 0016 Nummernkreis je Jahr und frei wählbares Schema.
-- Schema (pattern): e.g. 'R{Jahr}-{Nummer}' or 'R{Nummer}-{Jahr}'; tokens {Nummer} (alias
-- {FortlaufendeNummer}), {Jahr}, {JJ}, {Monat}, case-insensitive (same rules as
-- packages/domain/src/numbering.ts). It replaces prefix + include_year, which stay as columns
-- only for compatibility.
--
-- Je Jahr: with "jährlich neu beginnen" every year has its own counter, so a
-- backdated document (December date after New Year) draws the next number of ITS year instead of
-- restarting a year that already has numbers. In addition next_number() skips every number that
-- is already in use, so a number is never issued twice, whatever the settings were in the past.

CREATE TABLE IF NOT EXISTS number_sequence_year (
  tenant_id   uuid NOT NULL REFERENCES tenant (id),
  kind        text NOT NULL,
  year        smallint NOT NULL CHECK (year BETWEEN 2000 AND 2999),
  next_value  bigint NOT NULL CHECK (next_value >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind, year),
  FOREIGN KEY (tenant_id, kind) REFERENCES number_sequence (tenant_id, kind)
);
SELECT enable_tenant_rls('number_sequence_year');
SELECT add_updated_at_trigger('number_sequence_year');

ALTER TABLE number_sequence ADD COLUMN IF NOT EXISTS pattern text;
UPDATE number_sequence
  SET pattern = replace(replace(prefix, '{', ''), '}', '')
             || CASE WHEN include_year THEN '{Jahr}-' ELSE '' END || '{Nummer}'
  WHERE pattern IS NULL;

-- Sequences created by older code paths (tenant setup) get their schema from prefix/include_year.
CREATE OR REPLACE FUNCTION number_sequence_default_pattern() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.pattern IS NULL THEN
    NEW.pattern := replace(replace(NEW.prefix, '{', ''), '}', '')
                || CASE WHEN NEW.include_year THEN '{Jahr}-' ELSE '' END || '{Nummer}';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_number_sequence_default_pattern BEFORE INSERT ON number_sequence
  FOR EACH ROW EXECUTE FUNCTION number_sequence_default_pattern();

ALTER TABLE number_sequence ALTER COLUMN pattern SET NOT NULL;
ALTER TABLE number_sequence ADD CONSTRAINT number_sequence_pattern_check CHECK (
  length(pattern) <= 40
  AND regexp_count(pattern, '\{(nummer|fortlaufendenummer)\}', 1, 'i') = 1);

CREATE OR REPLACE FUNCTION number_pattern_has_year(p_pattern text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT p_pattern ~* '\{(jahr|jj)\}' $$;

-- Counters of the old scheme (one counter, reset when the year changed) become the counter of
-- the year they were last used in.
INSERT INTO number_sequence_year (tenant_id, kind, year, next_value)
SELECT tenant_id, kind, current_year, next_value FROM number_sequence
WHERE reset_yearly AND current_year IS NOT NULL
ON CONFLICT DO NOTHING;

-- Invoice and credit note counters only move forward, per year as well.
CREATE OR REPLACE FUNCTION number_sequence_year_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.kind IN ('invoice', 'credit_note') THEN
      RAISE EXCEPTION 'number sequence % must not be deleted', OLD.kind USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.kind IN ('invoice', 'credit_note') AND NEW.next_value < OLD.next_value THEN
    RAISE EXCEPTION 'number sequence % must not be decreased', OLD.kind USING ERRCODE = 'P0001';
  END IF;
  IF NEW.kind <> OLD.kind OR NEW.year <> OLD.year OR NEW.tenant_id <> OLD.tenant_id THEN
    RAISE EXCEPTION 'number sequence % cannot be renamed', OLD.kind USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_number_sequence_year_guard BEFORE UPDATE OR DELETE ON number_sequence_year
  FOR EACH ROW EXECUTE FUNCTION number_sequence_year_guard();

-- "Jährlich neu beginnen" only works with the year in the number (otherwise the same number
-- would come again next year) – now for every kind, not only invoices.
-- Switching yearly restart off continues after the highest per-year counter.
CREATE OR REPLACE FUNCTION number_sequence_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.kind IN ('invoice', 'credit_note') THEN
      RAISE EXCEPTION 'number sequence % must not be deleted', OLD.kind USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.kind IS DISTINCT FROM OLD.kind
     AND (OLD.kind IN ('invoice', 'credit_note') OR NEW.kind IN ('invoice', 'credit_note')) THEN
    RAISE EXCEPTION 'number sequence % cannot be renamed', OLD.kind USING ERRCODE = 'P0001';
  END IF;
  IF NEW.reset_yearly AND NOT number_pattern_has_year(NEW.pattern)
     AND (NOT OLD.reset_yearly OR number_pattern_has_year(OLD.pattern)) THEN
    RAISE EXCEPTION 'number sequence % can only restart yearly with the year in the number', NEW.kind
      USING ERRCODE = 'P0001';
  END IF;
  IF OLD.reset_yearly AND NOT NEW.reset_yearly THEN
    NEW.next_value := greatest(NEW.next_value, coalesce((
      SELECT max(next_value) FROM number_sequence_year
      WHERE tenant_id = NEW.tenant_id AND kind = NEW.kind), 0));
  END IF;
  IF NEW.kind IN ('invoice', 'credit_note') AND NEW.next_value < OLD.next_value
     AND NOT (NEW.reset_yearly AND number_pattern_has_year(NEW.pattern)
              AND NEW.current_year > coalesce(OLD.current_year, 0)) THEN
    RAISE EXCEPTION 'number sequence % must not be decreased', OLD.kind USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;

-- Is a number already used by a record of this kind (current tenant, RLS)?
CREATE OR REPLACE FUNCTION number_in_use(p_kind text, p_number text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_kind = 'contact' THEN EXISTS (SELECT 1 FROM contact WHERE number = p_number)
    WHEN p_kind = 'project' THEN EXISTS (SELECT 1 FROM project WHERE number = p_number)
    WHEN p_kind IN ('invoice', 'credit_note') THEN EXISTS (
      SELECT 1 FROM document WHERE number = p_number AND type IN ('invoice', 'credit_note'))
    ELSE EXISTS (SELECT 1 FROM document WHERE number = p_number AND type = p_kind)
  END
$$;

-- Draws the next number inside the caller's transaction. A rollback releases nothing, so the
-- number is only consumed when the surrounding transaction (e.g. finalize) commits → gapless.
CREATE OR REPLACE FUNCTION next_number(p_kind text, p_date date DEFAULT current_date) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  s number_sequence;
  y smallint := extract(year FROM p_date)::smallint;
  v bigint;
  result text;
BEGIN
  -- Lock the sequence: concurrent callers of the same kind wait here (no duplicates, no gaps).
  SELECT * INTO s FROM number_sequence
    WHERE tenant_id = current_tenant_id() AND kind = p_kind
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no number sequence % for current tenant', p_kind USING ERRCODE = 'P0002';
  END IF;
  IF s.reset_yearly THEN
    INSERT INTO number_sequence_year (tenant_id, kind, year, next_value)
    VALUES (s.tenant_id, s.kind, y,
            -- A year the single counter was already used in continues after it.
            CASE WHEN s.current_year IS NOT NULL AND y <= s.current_year
                 THEN greatest(s.next_value, s.start_value) ELSE s.start_value END)
    ON CONFLICT DO NOTHING;
    SELECT next_value INTO v FROM number_sequence_year
      WHERE tenant_id = s.tenant_id AND kind = s.kind AND year = y;
  ELSE
    v := s.next_value;
  END IF;
  LOOP
    -- lpad would cut longer numbers, so only pad when shorter than the minimum length.
    result := regexp_replace(s.pattern, '\{(nummer|fortlaufendenummer)\}',
                CASE WHEN length(v::text) >= s.min_length THEN v::text
                     ELSE lpad(v::text, s.min_length, '0') END, 'gi');
    result := regexp_replace(result, '\{jahr\}', y::text, 'gi');
    result := regexp_replace(result, '\{jj\}', lpad((y % 100)::text, 2, '0'), 'gi');
    result := regexp_replace(result, '\{monat\}', to_char(p_date, 'MM'), 'gi');
    EXIT WHEN NOT number_in_use(p_kind, result);
    v := v + 1;  -- already used (e.g. settings changed in the past): never issue it again
  END LOOP;
  IF s.reset_yearly THEN
    UPDATE number_sequence_year SET next_value = v + 1
      WHERE tenant_id = s.tenant_id AND kind = s.kind AND year = y;
    UPDATE number_sequence SET current_year = greatest(coalesce(current_year, y), y)
      WHERE tenant_id = s.tenant_id AND kind = s.kind;
  ELSE
    UPDATE number_sequence SET next_value = v + 1, current_year = y
      WHERE tenant_id = s.tenant_id AND kind = s.kind;
  END IF;
  RETURN result;
END
$$;
