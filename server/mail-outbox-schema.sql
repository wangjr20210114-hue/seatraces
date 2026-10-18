CREATE TABLE IF NOT EXISTS mail_outbox (
 id uuid PRIMARY KEY,dedupe_key text UNIQUE NOT NULL,purpose text NOT NULL,
 state text NOT NULL CHECK(state IN ('queued','sending','retry','sent','failed','expired','unknown')),
 payload bytea,nonce bytea,tag bytea,
 attempts int NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 4),
 next_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,
 lease_until timestamptz,last_error text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(coalesce(octet_length(payload),0)<=4096)
);
CREATE INDEX IF NOT EXISTS mail_outbox_ready ON mail_outbox(state,next_at,created_at);
