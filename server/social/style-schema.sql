CREATE TABLE IF NOT EXISTS post_features (
 post_id uuid PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE, revision integer NOT NULL,
 features jsonb NOT NULL, algorithm text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS trip_features (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, source_kind text NOT NULL, source_id uuid NOT NULL,
 source_version integer NOT NULL, features jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(source_kind,source_id)
);
CREATE TABLE IF NOT EXISTS user_place_style_choices (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, place_id text NOT NULL, trip_id uuid REFERENCES trips(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('wish','edit')), value integer NOT NULL CHECK(value IN (-1,1)), features jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,place_id,kind)
);
CREATE TABLE IF NOT EXISTS social_adoptions (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,post_id)
);
CREATE TABLE IF NOT EXISTS user_style_evidence (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, origin varchar(120) NOT NULL, dimension varchar(80) NOT NULL,
 value double precision NOT NULL CHECK(value BETWEEN -1 AND 1), weight double precision NOT NULL CHECK(weight BETWEEN 0 AND 3),
 source varchar(40) NOT NULL, observed_at timestamptz NOT NULL, PRIMARY KEY(user_id,origin,dimension)
);
CREATE TABLE IF NOT EXISTS user_style_dimensions (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, dimension varchar(80) NOT NULL,
 window_kind text NOT NULL CHECK(window_kind IN ('short','long')), value double precision NOT NULL, strength double precision NOT NULL,
 confidence double precision NOT NULL CHECK(confidence BETWEEN 0 AND 1), samples integer NOT NULL,
 algorithm text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,dimension,window_kind)
);
CREATE TABLE IF NOT EXISTS style_dirty_users (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, version bigint NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION mark_style_dirty() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE uid uuid; pid uuid;
BEGIN
 IF TG_OP='DELETE' THEN uid:=OLD.user_id; ELSE uid:=NEW.user_id; END IF;
 IF EXISTS(SELECT 1 FROM users WHERE id=uid) THEN
  INSERT INTO style_dirty_users(user_id) VALUES(uid) ON CONFLICT(user_id) DO UPDATE SET version=style_dirty_users.version+1,updated_at=now();
 END IF;
 IF TG_TABLE_NAME='posts' THEN
  IF TG_OP='DELETE' THEN pid:=OLD.id; ELSE pid:=NEW.id; END IF;
  INSERT INTO style_dirty_users(user_id) SELECT DISTINCT r.user_id FROM (
    SELECT user_id FROM reactions WHERE post_id=pid UNION SELECT user_id FROM browse_events WHERE post_id=pid
    UNION SELECT user_id FROM social_feedback WHERE post_id=pid UNION SELECT user_id FROM social_adoptions WHERE post_id=pid
   ) r JOIN users u ON u.id=r.user_id
   ON CONFLICT(user_id) DO UPDATE SET version=style_dirty_users.version+1,updated_at=now();
 END IF;
 RETURN NULL;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['trips','citywalks','posts','reactions','browse_events','social_feedback','social_adoptions','user_place_style_choices'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS social_style_dirty ON %I',t);
  EXECUTE format('CREATE TRIGGER social_style_dirty AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION mark_style_dirty()',t);
 END LOOP;
END $$;
