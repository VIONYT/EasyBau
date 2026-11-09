-- 0018 Briefpapier (DIN 5008 Form B): layout per company, designed in the web app, and logos.
-- Finalized documents freeze the layout in issuer_snapshot (rule 4); logos referenced there are
-- immutable and never deleted, so a reprint in ten years looks the same.

CREATE TABLE IF NOT EXISTS letterhead (
  tenant_id   uuid PRIMARY KEY REFERENCES tenant (id),
  layout      jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES app_user (id)
);
SELECT enable_tenant_rls('letterhead');
SELECT add_updated_at_trigger('letterhead');
SELECT add_audit_trigger('letterhead');

-- Company assets (logo images). Content-addressed per company, insert-only.
CREATE TABLE IF NOT EXISTS tenant_asset (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id),
  kind        text NOT NULL CHECK (kind IN ('logo')),
  storage_key text NOT NULL,
  sha256      bytea NOT NULL CHECK (length(sha256) = 32),
  mime_type   text NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
  size_bytes  bigint NOT NULL CHECK (size_bytes > 0),
  created_by  uuid REFERENCES app_user (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sha256)
);
SELECT enable_tenant_rls('tenant_asset');
REVOKE UPDATE, DELETE ON tenant_asset FROM opc_app;
CREATE TRIGGER trg_tenant_asset_immutable BEFORE UPDATE OR DELETE ON tenant_asset
  FOR EACH ROW EXECUTE FUNCTION reject_modification();
