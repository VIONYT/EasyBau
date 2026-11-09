-- 0019 Handschriftliche Unterschriften: drawn in the browser (pen, finger, mouse), stored as PNG in
-- tenant_asset (insert-only). A user may keep one signature in the account and reuse it; the
-- client's signature is drawn on site and only attached to the signed record.

ALTER TABLE tenant_asset DROP CONSTRAINT IF EXISTS tenant_asset_kind_check;
ALTER TABLE tenant_asset ADD CONSTRAINT tenant_asset_kind_check CHECK (kind IN ('logo', 'signature'));

-- The signature a user keeps in the account (per company; replaced or removed by the user only).
CREATE TABLE IF NOT EXISTS user_signature (
  tenant_id   uuid NOT NULL REFERENCES tenant (id),
  user_id     uuid NOT NULL REFERENCES app_user (id),
  asset_id    uuid NOT NULL REFERENCES tenant_asset (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
SELECT enable_tenant_rls('user_signature');
SELECT add_updated_at_trigger('user_signature');
SELECT add_audit_trigger('user_signature');

-- Signature images on signed reports and joint measurements (frozen with the record).
ALTER TABLE report_signature ADD COLUMN IF NOT EXISTS image_asset_id uuid REFERENCES tenant_asset (id);
ALTER TABLE measurement_sheet
  ADD COLUMN IF NOT EXISTS contractor_signature_asset_id uuid REFERENCES tenant_asset (id),
  ADD COLUMN IF NOT EXISTS client_signature_asset_id uuid REFERENCES tenant_asset (id);
