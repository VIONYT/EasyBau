-- 0012 Stammdaten (Leistungen, Materialien) and supplier catalogs imported from DATANORM.
-- Supplier catalogs stay separate from the own Stammdaten: they can have 100 000+ articles,
-- are replaced by updates and are only searched; articles are copied into Stammdaten or
-- documents when used.

-- Own Stammdaten: link to the supplier article they were taken from, EAN, discount group.
ALTER TABLE catalog_item ADD COLUMN ean text;
ALTER TABLE catalog_item ADD COLUMN supplier_name text;
ALTER TABLE catalog_item ADD CONSTRAINT catalog_item_text_check CHECK (length(short_text) BETWEEN 1 AND 500);
SELECT add_audit_trigger('catalog_item');
SELECT add_audit_trigger('catalog_folder');
CREATE INDEX catalog_item_kind_idx ON catalog_item (tenant_id, kind, lower(short_text)) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX catalog_folder_name_uq ON catalog_folder (tenant_id, kind, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

CREATE TABLE supplier_catalog (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  supplier      text,
  format        text NOT NULL DEFAULT 'datanorm' CHECK (format IN ('datanorm')),
  version       text,
  currency      char(3) NOT NULL DEFAULT 'EUR',
  -- Default discount on list prices (Rabatt des Großhändlers); per discount group below.
  discount_percent numeric(7,4) NOT NULL DEFAULT 0 CHECK (discount_percent >= 0 AND discount_percent < 100),
  article_count integer NOT NULL DEFAULT 0,
  imported_at   timestamptz,
  created_by    uuid REFERENCES app_user (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
SELECT enable_tenant_rls('supplier_catalog');
SELECT add_updated_at_trigger('supplier_catalog');
SELECT add_audit_trigger('supplier_catalog');

CREATE TABLE supplier_discount (
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  catalog_id    uuid NOT NULL REFERENCES supplier_catalog (id) ON DELETE CASCADE,
  discount_group text NOT NULL,
  percent       numeric(7,4) NOT NULL CHECK (percent >= 0 AND percent < 100),
  PRIMARY KEY (catalog_id, discount_group)
);
SELECT enable_tenant_rls('supplier_discount');

CREATE TABLE supplier_article (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  catalog_id    uuid NOT NULL REFERENCES supplier_catalog (id) ON DELETE CASCADE,
  article_no    text NOT NULL,
  short_text    text NOT NULL,
  long_text     text,
  long_text_key text,
  unit_raw      text,
  unit_id       uuid REFERENCES unit (id),
  price_kind    text NOT NULL CHECK (price_kind IN ('list', 'net')),
  -- Price as listed for price_unit units, exact cents (may contain fractions of a cent).
  price_cents   numeric(18,4) NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  price_unit    integer NOT NULL DEFAULT 1 CHECK (price_unit IN (1, 10, 100, 1000)),
  discount_group text,
  product_group text,
  matchcode     text,
  ean           text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  search        tsvector GENERATED ALWAYS AS (
                  to_tsvector('german', short_text || ' ' || coalesce(long_text, '') || ' ' ||
                              article_no || ' ' || coalesce(matchcode, '') || ' ' || coalesce(ean, ''))) STORED,
  UNIQUE (catalog_id, article_no)
);
SELECT enable_tenant_rls('supplier_article');
CREATE INDEX supplier_article_search_idx ON supplier_article USING gin (search);
CREATE INDEX supplier_article_text_idx ON supplier_article (catalog_id, lower(short_text));

-- Long texts arrive separately (T records) and are joined after the import.
CREATE TABLE supplier_text (
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  catalog_id    uuid NOT NULL REFERENCES supplier_catalog (id) ON DELETE CASCADE,
  text_key      text NOT NULL,
  line_no       integer NOT NULL,
  text          text NOT NULL,
  PRIMARY KEY (catalog_id, text_key, line_no)
);
SELECT enable_tenant_rls('supplier_text');

ALTER TABLE catalog_item ADD COLUMN supplier_article_id uuid REFERENCES supplier_article (id) ON DELETE SET NULL;

-- Default folder „Allgemein“ for both lists (DESIGN.md §2 Stammdaten).
CREATE OR REPLACE FUNCTION seed_catalog_defaults() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  t uuid := current_tenant_id();
BEGIN
  IF t IS NULL THEN
    RAISE EXCEPTION 'seed_catalog_defaults requires app.tenant_id' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO catalog_folder (tenant_id, kind, name, sort)
  SELECT t, k, 'Allgemein', 0 FROM unnest(ARRAY['service', 'material']) AS k
  WHERE NOT EXISTS (SELECT 1 FROM catalog_folder f WHERE f.tenant_id = t AND f.kind = k);
END
$$;

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);
    PERFORM seed_catalog_defaults();
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END
$$;
