CREATE TABLE IF NOT EXISTS place_service_prices (
 place_id text PRIMARY KEY, fingerprint text NOT NULL, payload jsonb NOT NULL,
 checked_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS place_service_prices_expiry ON place_service_prices(expires_at);
