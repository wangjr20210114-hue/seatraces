-- Additive, bounded recommendation data. No raw questionnaires or POI trees.
CREATE TABLE IF NOT EXISTS recommendation_demo_batches (
 id uuid PRIMARY KEY, seed integer NOT NULL, algorithm text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 manifest jsonb NOT NULL, status text NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','removed'))
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS synthetic_batch_id uuid REFERENCES recommendation_demo_batches(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS analytics_excluded boolean NOT NULL DEFAULT false;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS synthetic_batch_id uuid REFERENCES recommendation_demo_batches(id);
CREATE TABLE IF NOT EXISTS recommendation_profiles (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 travel jsonb NOT NULL DEFAULT '{}', content jsonb NOT NULL DEFAULT '{}', authors jsonb NOT NULL DEFAULT '{}',
 vector real[] NOT NULL, evidence jsonb NOT NULL DEFAULT '[]', version bigint NOT NULL DEFAULT 1,
 algorithm text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), CHECK(cardinality(vector)=96)
);
CREATE TABLE IF NOT EXISTS recommendation_items (
 post_id uuid PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE, revision integer NOT NULL,
 concepts text[] NOT NULL, cities text[] NOT NULL, features jsonb NOT NULL, vector real[] NOT NULL,
 route_key text, algorithm text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), CHECK(cardinality(vector)=96)
);
CREATE TABLE IF NOT EXISTS recommendation_models (
 id uuid PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('two_tower','ranker')),
 scope text NOT NULL CHECK(scope IN ('synthetic','real')), state text NOT NULL CHECK(state IN ('evaluated','active','rejected')),
 artifact jsonb NOT NULL, digest text NOT NULL, metrics jsonb NOT NULL, cutoff timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), CHECK(pg_column_size(artifact)<1000000)
);
CREATE UNIQUE INDEX IF NOT EXISTS recommendation_one_model ON recommendation_models(kind,scope) WHERE state='active';
CREATE TABLE IF NOT EXISTS recommendation_embeddings (
 model_id uuid REFERENCES recommendation_models(id) ON DELETE CASCADE,
 post_id uuid REFERENCES posts(id) ON DELETE CASCADE, revision integer NOT NULL, vector real[] NOT NULL,
 PRIMARY KEY(model_id,post_id), CHECK(cardinality(vector)=32)
);
CREATE TABLE IF NOT EXISTS recommendation_requests (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 profile_version bigint NOT NULL, user_vector real[] NOT NULL, context jsonb NOT NULL,
 candidate_ids uuid[] NOT NULL, trace jsonb NOT NULL, algorithm text NOT NULL, model_id uuid REFERENCES recommendation_models(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(), CHECK(cardinality(candidate_ids)<=120), CHECK(cardinality(user_vector)=96)
);
CREATE INDEX IF NOT EXISTS recommendation_requests_owner ON recommendation_requests(user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS recommendation_exposures (
 id uuid PRIMARY KEY REFERENCES social_impressions(id) ON DELETE CASCADE,
 request_id uuid NOT NULL REFERENCES recommendation_requests(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
 position integer NOT NULL CHECK(position BETWEEN 0 AND 119), item_vector real[] NOT NULL,
 visible_ms integer NOT NULL DEFAULT 0 CHECK(visible_ms BETWEEN 0 AND 120000), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(cardinality(item_vector)=96)
);
CREATE TABLE IF NOT EXISTS recommendation_outcomes (
 id bigserial PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 post_id uuid REFERENCES posts(id) ON DELETE CASCADE, author_id uuid REFERENCES users(id) ON DELETE CASCADE,
 kind text NOT NULL, active boolean NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recommendation_outcome_lookup ON recommendation_outcomes(user_id,post_id,occurred_at);
CREATE TABLE IF NOT EXISTS recommendation_trip_sources (
 session_id uuid PRIMARY KEY REFERENCES journey_sessions(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
 trip_id uuid UNIQUE REFERENCES trips(id) ON DELETE CASCADE, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS recommendation_trip_feedback (
 trip_id uuid PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 rating integer NOT NULL CHECK(rating BETWEEN 1 AND 5), aspects jsonb NOT NULL DEFAULT '{}',
 experience text NOT NULL DEFAULT 'plan' CHECK(experience IN ('plan','trip')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION recommendation_dot(a real[],b real[]) RETURNS double precision LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT coalesce(sum(x*y),0)::double precision FROM unnest(a,b) v(x,y)
$$;
-- Current-state profiles and temporal training labels have different jobs.
-- The trigger records reversals, never treats an unchanged replay as a new vote.
CREATE OR REPLACE FUNCTION recommendation_signal() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE r jsonb; uid uuid; pid uuid; aid uuid; k text; enabled boolean;
BEGIN
 IF TG_OP='UPDATE' AND to_jsonb(NEW)=to_jsonb(OLD) THEN RETURN NULL; END IF;
 r:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 uid:=(r->>'user_id')::uuid; pid:=(r->>'post_id')::uuid; aid:=(r->>'author_id')::uuid;
 IF NOT EXISTS(SELECT 1 FROM users WHERE id=uid) THEN RETURN NULL; END IF;
 IF pid IS NOT NULL AND NOT EXISTS(SELECT 1 FROM posts WHERE id=pid) THEN RETURN NULL; END IF;
 IF aid IS NOT NULL AND NOT EXISTS(SELECT 1 FROM users WHERE id=aid) THEN
  INSERT INTO style_dirty_users(user_id) VALUES(uid) ON CONFLICT(user_id) DO UPDATE SET version=style_dirty_users.version+1,updated_at=now();
  RETURN NULL;
 END IF;
 enabled:=TG_OP<>'DELETE';
 IF TG_TABLE_NAME='recommendation_trip_feedback' THEN
  SELECT post_id INTO pid FROM recommendation_trip_sources WHERE trip_id=(r->>'trip_id')::uuid AND user_id=uid;
  IF pid IS NOT NULL THEN
   INSERT INTO recommendation_outcomes(user_id,post_id,kind,active) VALUES
    (uid,pid,'satisfied',enabled AND r->>'experience'='trip' AND (r->>'rating')::int>=4),
    (uid,pid,'dissatisfied',enabled AND r->>'experience'='trip' AND (r->>'rating')::int<=2);
  END IF;
 END IF;
 k:=CASE TG_TABLE_NAME WHEN 'reactions' THEN r->>'kind' WHEN 'comments' THEN 'comment' WHEN 'user_follows' THEN 'follow'
 WHEN 'social_adoptions' THEN 'adopt_intent' WHEN 'social_feedback' THEN 'not_interested' END;
 IF k IS NOT NULL THEN
  IF TG_TABLE_NAME='comments' THEN enabled:=enabled AND r->>'hidden_at' IS NULL; END IF;
  INSERT INTO recommendation_outcomes(user_id,post_id,author_id,kind,active) VALUES(uid,pid,aid,k,enabled);
 END IF;
 INSERT INTO style_dirty_users(user_id) VALUES(uid) ON CONFLICT(user_id) DO UPDATE SET version=style_dirty_users.version+1,updated_at=now();
 RETURN NULL;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['reactions','comments','user_follows','social_adoptions','social_feedback','recommendation_trip_feedback'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS recommendation_signal ON %I',t);
  EXECUTE format('CREATE TRIGGER recommendation_signal AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION recommendation_signal()',t);
 END LOOP;
END $$;
