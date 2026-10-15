CREATE TABLE IF NOT EXISTS agent_conversations (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 state jsonb NOT NULL DEFAULT '{}', revision integer NOT NULL DEFAULT 0,
 busy_until timestamptz, busy_token uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_conversations_owner ON agent_conversations(user_id,updated_at DESC);
CREATE TABLE IF NOT EXISTS agent_turns (
 id uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, request_id uuid NOT NULL,
 input text NOT NULL, response jsonb, status text NOT NULL CHECK(status IN ('running','completed','failed')),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(conversation_id,request_id)
);
CREATE INDEX IF NOT EXISTS agent_turns_owner ON agent_turns(user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS agent_actions (
 id uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, capability text NOT NULL,
 payload jsonb NOT NULL, preview jsonb NOT NULL, result jsonb,
 status text NOT NULL CHECK(status IN ('pending','executing','completed','cancelled','failed','unknown')),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',
 finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS agent_actions_owner ON agent_actions(user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS agent_tool_calls (
 id bigserial PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 method text NOT NULL, path text NOT NULL, status integer, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS user_travel_memory (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 dimension text NOT NULL CHECK(dimension IN ('pace','transport','crowd','revisit','interests')),
 value jsonb NOT NULL, strength double precision NOT NULL CHECK(strength BETWEEN 0 AND 1),
 confidence double precision NOT NULL CHECK(confidence BETWEEN 0 AND 1), evidence text NOT NULL,
 source text NOT NULL CHECK(source='user_confirmed'), version integer NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '180 days',
 PRIMARY KEY(user_id,dimension)
);
CREATE TABLE IF NOT EXISTS agent_knowledge (
 id text PRIMARY KEY, version text NOT NULL, title text NOT NULL, content text NOT NULL,
 route text NOT NULL, embedding double precision[], embedding_model text, updated_at timestamptz NOT NULL DEFAULT now()
);
