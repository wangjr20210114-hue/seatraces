-- Additive migration: existing account IDs, profiles and trips stay intact.
CREATE UNIQUE INDEX IF NOT EXISTS users_username_normalized ON users (lower(username));
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_synthetic boolean NOT NULL DEFAULT false;
-- Existing legacy choices are left as historical data and no longer read as switches.
-- Do not rewrite them to true and misrepresent a user action.
ALTER TABLE users ALTER COLUMN preferences SET DEFAULT '{"interests":["人文","自然"],"pace":"balanced"}'::jsonb;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS user_emails (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 email varchar(254) NOT NULL UNIQUE CHECK(email=lower(email)),
 verified_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS account_tokens (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 purpose text NOT NULL CHECK(purpose IN ('verify_email','reset_password')),
 email varchar(254) NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL, used_at timestamptz
);
CREATE INDEX IF NOT EXISTS account_tokens_owner ON account_tokens(user_id,purpose);
CREATE TABLE IF NOT EXISTS auth_rate_limits (
 key_hash text PRIMARY KEY, hits integer NOT NULL, until timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS user_avatars (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 image bytea NOT NULL CHECK(octet_length(image)<=262144),
 updated_at timestamptz NOT NULL DEFAULT now()
);
