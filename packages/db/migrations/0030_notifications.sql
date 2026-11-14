-- 0030 Benachrichtigungen (P2.8): per person, e.g. Bericht unterschrieben, Nachtrag beauftragt
-- oder abgelehnt, Rechnung überfällig. Not tax-relevant (no audit); one entry per person, kind
-- and object, so repeated events do not pile up.

CREATE TABLE notification (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id),
  user_id     uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('invoice_overdue', 'change_order_decided', 'report_signed')),
  ref_id      uuid NOT NULL,
  title       text NOT NULL CHECK (length(title) <= 300),
  body        text CHECK (length(body) <= 1000),
  -- Path in the web app, e.g. /dokumente/<id>; only internal paths.
  route       text NOT NULL CHECK (route ~ '^/[a-z0-9/-]*$' AND length(route) <= 200),
  created_at  timestamptz NOT NULL DEFAULT now(),
  read_at     timestamptz,
  UNIQUE (tenant_id, user_id, kind, ref_id)
);
SELECT enable_tenant_rls('notification');
CREATE INDEX notification_user_idx ON notification (user_id, created_at DESC);
CREATE INDEX notification_unread_idx ON notification (user_id) WHERE read_at IS NULL;
