-- Control-plane tables (secret metadata, rotation state, usage telemetry,
-- alerts) plus a tiny "app" table that stands in for a real dependent
-- service's data, so live-traffic tests exercise real SELECT/INSERT
-- statements under the rotated role.

CREATE TABLE IF NOT EXISTS secrets (
  id                  SERIAL PRIMARY KEY,
  secret_name         TEXT NOT NULL,
  role_name           TEXT NOT NULL UNIQUE,
  encrypted_password  BYTEA NOT NULL,
  iv                  BYTEA NOT NULL,
  auth_tag            BYTEA NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'retiring', 'revoked')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_secrets_name_status ON secrets (secret_name, status);

CREATE TABLE IF NOT EXISTS rotations (
  id                        SERIAL PRIMARY KEY,
  secret_name               TEXT NOT NULL,
  old_secret_id             INT NOT NULL REFERENCES secrets (id),
  new_secret_id             INT NOT NULL REFERENCES secrets (id),
  state                     TEXT NOT NULL DEFAULT 'overlapping'
                              CHECK (state IN ('overlapping', 'alerted', 'revoked')),
  grace_period_ends_at      TIMESTAMPTZ NOT NULL,
  consecutive_zero_checks   INT NOT NULL DEFAULT 0,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at              TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS usage_telemetry (
  id                   SERIAL PRIMARY KEY,
  rotation_id          INT NOT NULL REFERENCES rotations (id),
  role_name            TEXT NOT NULL,
  active_connections   INT NOT NULL,
  checked_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alerts (
  id            SERIAL PRIMARY KEY,
  rotation_id   INT NOT NULL UNIQUE REFERENCES rotations (id),
  message       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Stand-in application data. Rotated roles are granted just enough
-- privilege on this table via membership in app_group (created by
-- scripts/setup-db.sh before this file runs).
CREATE TABLE IF NOT EXISTS orders (
  id           SERIAL PRIMARY KEY,
  note         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON orders TO app_group;
GRANT USAGE, SELECT ON SEQUENCE orders_id_seq TO app_group;
