-- 0002 Master data: roles & membership, settings tables, units, contacts, projects, catalog.

-- ---------------------------------------------------------------------------
-- Roles, membership (DESIGN.md §5.2)
-- ---------------------------------------------------------------------------

CREATE TABLE role (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  key         text NOT NULL,                    -- admin | office_lead | project_lead | team_lead | team_member | auditor | custom_*
  name        text NOT NULL,
  access      text NOT NULL CHECK (access IN ('office', 'site', 'readonly')),
  permissions text[] NOT NULL DEFAULT '{}',
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);
SELECT enable_tenant_rls('role');
SELECT add_updated_at_trigger('role');
SELECT add_audit_trigger('role');

CREATE TABLE membership (
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  role_id     uuid NOT NULL REFERENCES role (id),
  wage_group_id uuid,
  valid_until date,                              -- e.g. time-limited auditor access
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
SELECT enable_tenant_rls('membership');
SELECT add_audit_trigger('membership');

-- ---------------------------------------------------------------------------
-- Settings: units, tax rates, wage groups, surcharges, payment terms, holidays
-- ---------------------------------------------------------------------------

CREATE TABLE unit (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  symbol      text NOT NULL,
  name        text NOT NULL,
  dimension   text NOT NULL CHECK (dimension IN (
                'length', 'area', 'volume', 'mass', 'time', 'count', 'container', 'lump_sum', 'power')),
  unece_code  text NOT NULL CHECK (unece_code ~ '^[A-Z0-9]{2,3}$'),
  decimals    smallint NOT NULL DEFAULT 2 CHECK (decimals BETWEEN 0 AND 4),
  aliases     text[] NOT NULL DEFAULT '{}',
  is_system   boolean NOT NULL DEFAULT false,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, symbol)
);
SELECT enable_tenant_rls('unit');
SELECT add_updated_at_trigger('unit');

CREATE OR REPLACE FUNCTION unit_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.is_system THEN
    RAISE EXCEPTION 'system unit % cannot be deleted', OLD.symbol USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.is_system
     AND (NEW.unece_code <> OLD.unece_code OR NEW.dimension <> OLD.dimension OR NOT NEW.is_system) THEN
    RAISE EXCEPTION 'code and dimension of system unit % are fixed', OLD.symbol USING ERRCODE = 'P0001';
  END IF;
  RETURN coalesce(NEW, OLD);
END
$$;
CREATE TRIGGER trg_unit_guard BEFORE UPDATE OR DELETE ON unit
  FOR EACH ROW EXECUTE FUNCTION unit_guard();

CREATE TABLE tax_rate (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  country_code  char(2) NOT NULL DEFAULT 'DE',
  name          text NOT NULL,
  percent       numeric(7,4) NOT NULL CHECK (percent >= 0 AND percent < 100),
  category_code text NOT NULL CHECK (category_code IN ('S', 'Z', 'E', 'AE', 'K', 'G', 'O', 'L', 'M')),
  valid_from    date NOT NULL DEFAULT '2000-01-01',
  valid_to      date,
  is_default    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
SELECT enable_tenant_rls('tax_rate');

CREATE TABLE wage_group (
  id               uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id        uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  name             text NOT NULL,
  cost_per_hour_cents bigint NOT NULL CHECK (cost_per_hour_cents >= 0),
  markup_percent   numeric(7,4) NOT NULL DEFAULT 0,
  hourly_rate_cents bigint NOT NULL CHECK (hourly_rate_cents >= 0),  -- Stundenverrechnungssatz
  sort             integer NOT NULL DEFAULT 0,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
SELECT enable_tenant_rls('wage_group');
SELECT add_updated_at_trigger('wage_group');
ALTER TABLE membership ADD FOREIGN KEY (wage_group_id) REFERENCES wage_group (id);

-- Default surcharges per cost kind; not retroactive (copied into items when created).
CREATE TABLE surcharge (
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  cost_kind   text NOT NULL CHECK (cost_kind IN ('labor', 'material', 'equipment', 'subcontract', 'other')),
  percent     numeric(7,4) NOT NULL DEFAULT 0 CHECK (percent > -100),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, cost_kind)
);
SELECT enable_tenant_rls('surcharge');
SELECT add_updated_at_trigger('surcharge');

CREATE TABLE payment_term (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id         uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  name              text NOT NULL,
  due_days          smallint NOT NULL DEFAULT 7 CHECK (due_days BETWEEN 0 AND 365),
  cash_discount_percent numeric(7,4) CHECK (cash_discount_percent >= 0 AND cash_discount_percent < 100),
  cash_discount_days smallint CHECK (cash_discount_days BETWEEN 0 AND 365),
  is_default        boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((cash_discount_percent IS NULL) = (cash_discount_days IS NULL))
);
SELECT enable_tenant_rls('payment_term');
CREATE UNIQUE INDEX payment_term_default_uq ON payment_term (tenant_id) WHERE is_default;

CREATE TABLE working_hours (
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),   -- ISO: 1 = Monday
  start_time  time,
  end_time    time,
  break_minutes smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, weekday)
);
SELECT enable_tenant_rls('working_hours');

CREATE TABLE holiday (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  day         date NOT NULL,
  name        text NOT NULL,
  is_custom   boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, day)
);
SELECT enable_tenant_rls('holiday');

CREATE TABLE text_template (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  document_type text NOT NULL,
  placement   text NOT NULL CHECK (placement IN ('intro', 'closing')),
  name        text NOT NULL,
  body        text NOT NULL,
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
SELECT enable_tenant_rls('text_template');
SELECT add_updated_at_trigger('text_template');

-- ---------------------------------------------------------------------------
-- Contacts (CRM)
-- ---------------------------------------------------------------------------

CREATE TABLE contact (
  id              uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id       uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('person', 'organization')),
  number          text,                          -- Kundennummer (K-…), drawn from number_sequence
  organization_name text,
  salutation      text,
  title           text,
  first_name      text,
  last_name       text,
  website         text,
  color           text CHECK (color IS NULL OR color ~ '^#[0-9a-fA-F]{6}$'),
  description     text,
  -- billing defaults (DESIGN.md §2 Kontakte)
  payment_term_id uuid REFERENCES payment_term (id),
  tax_mode        text NOT NULL DEFAULT 'standard' CHECK (tax_mode IN (
                    'standard', 'reverse_charge_13b', 'small_business', 'intra_eu', 'export')),
  vat_id          text,
  buyer_reference text,                          -- Leitweg-ID
  einvoice_email  text,
  einvoice_format text CHECK (einvoice_format IN ('zugferd', 'xrechnung_ubl', 'xrechnung_cii')),
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES app_user (id),
  CHECK (
    (kind = 'organization' AND organization_name IS NOT NULL)
    OR (kind = 'person' AND (last_name IS NOT NULL OR first_name IS NOT NULL))
  )
);
SELECT enable_tenant_rls('contact');
SELECT add_updated_at_trigger('contact');
SELECT add_audit_trigger('contact');
CREATE UNIQUE INDEX contact_number_uq ON contact (tenant_id, number) WHERE number IS NOT NULL;
CREATE INDEX contact_search_idx ON contact USING gin (
  to_tsvector('german',
    coalesce(organization_name, '') || ' ' || coalesce(first_name, '') || ' ' ||
    coalesce(last_name, '') || ' ' || coalesce(number, '')));

CREATE TABLE contact_channel (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  contact_id  uuid NOT NULL REFERENCES contact (id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('email', 'phone', 'mobile', 'fax')),
  value       text NOT NULL,
  label       text NOT NULL DEFAULT 'work' CHECK (label IN ('work', 'private', 'other')),
  is_primary  boolean NOT NULL DEFAULT false
);
SELECT enable_tenant_rls('contact_channel');
CREATE INDEX contact_channel_contact_idx ON contact_channel (contact_id);

CREATE TABLE contact_address (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  contact_id    uuid NOT NULL REFERENCES contact (id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('main', 'billing', 'delivery', 'other')),
  recipient_block text,                        -- free recipient lines for billing addresses
  street        text,
  street_extra  text,
  postal_code   text,
  city          text,
  country_code  char(2) NOT NULL DEFAULT 'DE'
);
SELECT enable_tenant_rls('contact_address');
CREATE INDEX contact_address_contact_idx ON contact_address (contact_id);

CREATE TABLE contact_link (
  tenant_id       uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  person_id       uuid NOT NULL REFERENCES contact (id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES contact (id) ON DELETE CASCADE,
  role            text,
  PRIMARY KEY (person_id, organization_id),
  CHECK (person_id <> organization_id)
);
SELECT enable_tenant_rls('contact_link');

-- ---------------------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------------------

CREATE TABLE project_status (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  key         text NOT NULL,
  label       text NOT NULL,
  color       text,
  sort        integer NOT NULL DEFAULT 0,
  is_closed   boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, key)
);
SELECT enable_tenant_rls('project_status');

CREATE TABLE project (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  number        text,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 300),
  description   text,
  status_id     uuid REFERENCES project_status (id),
  customer_id   uuid REFERENCES contact (id),
  site_street   text,
  site_street_extra text,
  site_postal_code text,
  site_city     text,
  site_country_code char(2) NOT NULL DEFAULT 'DE',
  site_lat      numeric(9,6),
  site_lon      numeric(9,6),
  start_date    date,
  end_date      date,
  archived_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES app_user (id),
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);
SELECT enable_tenant_rls('project');
SELECT add_updated_at_trigger('project');
SELECT add_audit_trigger('project');
CREATE UNIQUE INDEX project_number_uq ON project (tenant_id, number) WHERE number IS NOT NULL;
CREATE INDEX project_customer_idx ON project (customer_id);
CREATE INDEX project_active_idx ON project (tenant_id, updated_at DESC) WHERE archived_at IS NULL;

CREATE TABLE project_member (
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, user_id)
);
SELECT enable_tenant_rls('project_member');

-- ---------------------------------------------------------------------------
-- Catalog (Stammdaten: Leistungen & Materialien)
-- ---------------------------------------------------------------------------

CREATE TABLE catalog_folder (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  parent_id   uuid REFERENCES catalog_folder (id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('service', 'material')),
  name        text NOT NULL,
  sort        integer NOT NULL DEFAULT 0
);
SELECT enable_tenant_rls('catalog_folder');

CREATE TABLE catalog_item (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('service', 'material')),
  folder_id     uuid REFERENCES catalog_folder (id) ON DELETE SET NULL,
  article_no    text,
  manufacturer  text,
  short_text    text NOT NULL,
  long_text     text,
  unit_id       uuid NOT NULL REFERENCES unit (id),
  calc_mode     text NOT NULL DEFAULT 'unit_price' CHECK (calc_mode IN ('unit_price', 'total_price')),
  cost_cents    bigint NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  markup_percent numeric(7,4) NOT NULL DEFAULT 0,
  price_cents   bigint NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  pack_size     numeric(18,4) CHECK (pack_size > 0),           -- Gebindeinhalt
  pack_unit_id  uuid REFERENCES unit (id),
  image_file_id uuid,
  source        text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import', 'datanorm')),
  archived_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
SELECT enable_tenant_rls('catalog_item');
SELECT add_updated_at_trigger('catalog_item');
CREATE INDEX catalog_item_search_idx ON catalog_item USING gin (
  to_tsvector('german', short_text || ' ' || coalesce(long_text, '') || ' ' || coalesce(article_no, '')));
CREATE INDEX catalog_item_folder_idx ON catalog_item (folder_id);

CREATE TABLE catalog_component (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  catalog_item_id uuid NOT NULL REFERENCES catalog_item (id) ON DELETE CASCADE,
  sort          integer NOT NULL DEFAULT 0,
  cost_kind     text NOT NULL CHECK (cost_kind IN ('labor', 'material', 'equipment', 'subcontract', 'other')),
  quantity      numeric(18,4) NOT NULL DEFAULT 1,
  unit_id       uuid REFERENCES unit (id),
  description   text,
  unit_cost_cents bigint NOT NULL DEFAULT 0 CHECK (unit_cost_cents >= 0),
  wage_group_id uuid REFERENCES wage_group (id),
  material_item_id uuid REFERENCES catalog_item (id),
  markup_percent numeric(7,4)                  -- NULL = default surcharge of the cost kind
);
SELECT enable_tenant_rls('catalog_component');
CREATE INDEX catalog_component_item_idx ON catalog_component (catalog_item_id);
