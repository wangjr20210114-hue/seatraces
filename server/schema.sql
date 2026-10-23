-- 定义城市、地点、旅行问卷和行程的数据表、索引和关联结构。

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY, username varchar(32) UNIQUE NOT NULL, password_hash text NOT NULL,
 nickname varchar(40) NOT NULL, avatar varchar(12) NOT NULL DEFAULT '🌊', role text NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
 preferences jsonb NOT NULL DEFAULT '{"interests":["人文","自然"],"pace":"balanced"}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (token_hash text PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at timestamptz NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS places (
 id text PRIMARY KEY, name text NOT NULL, aliases text[] NOT NULL DEFAULT '{}', category text NOT NULL CHECK(category IN ('city','attraction','hotel','hostel','rest','station')),
 country text NOT NULL, province text NOT NULL DEFAULT '', city text NOT NULL, lat double precision NOT NULL CHECK(lat BETWEEN -90 AND 90), lng double precision NOT NULL CHECK(lng BETWEEN -180 AND 180),
 coord_system text NOT NULL DEFAULT 'WGS84' CHECK(coord_system='WGS84'), timezone text NOT NULL DEFAULT 'Asia/Shanghai', tags text[] NOT NULL DEFAULT '{}',
 description text NOT NULL DEFAULT '', duration_min integer NOT NULL DEFAULT 90 CHECK(duration_min BETWEEN 0 AND 1440),
 hours jsonb, cost numeric(10,2) NOT NULL DEFAULT 0 CHECK(cost>=0), currency text NOT NULL DEFAULT 'CNY',
 source text NOT NULL, license text NOT NULL, source_url text NOT NULL DEFAULT '', verified_at timestamptz,
 data_status text NOT NULL DEFAULT 'demo' CHECK(data_status IN ('demo','reference','verified')), updated_at timestamptz NOT NULL DEFAULT now(), search_text text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS places_search ON places USING gin(search_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS places_city_category ON places(city,category);
CREATE INDEX IF NOT EXISTS places_country_province ON places(country,province,category);
CREATE INDEX IF NOT EXISTS places_tags ON places USING gin(tags);
CREATE TABLE IF NOT EXISTS trips (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,title text NOT NULL,
 request jsonb NOT NULL, plan jsonb NOT NULL, version integer NOT NULL DEFAULT 1,
 status text NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','completed')), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trips_owner ON trips(user_id,updated_at DESC);
CREATE TABLE IF NOT EXISTS trip_versions (trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,version integer NOT NULL,plan jsonb NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(trip_id,version));
CREATE TABLE IF NOT EXISTS posts (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,trip_id uuid REFERENCES trips(id) ON DELETE SET NULL,
 title varchar(100) NOT NULL,body varchar(4000) NOT NULL,tags text[] NOT NULL DEFAULT '{}',snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,trip_id)
);
CREATE TABLE IF NOT EXISTS reactions (user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,kind text NOT NULL CHECK(kind IN ('like','save','recommend')),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,post_id,kind));
CREATE INDEX IF NOT EXISTS reactions_post ON reactions(post_id,kind);
CREATE TABLE IF NOT EXISTS comments (id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,body varchar(500) NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS browse_events (user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,day date NOT NULL DEFAULT CURRENT_DATE,dwell_seconds integer NOT NULL DEFAULT 0 CHECK(dwell_seconds BETWEEN 0 AND 120),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,post_id,day));
CREATE TABLE IF NOT EXISTS api_usage (id bigserial PRIMARY KEY,provider text NOT NULL,reserved_cny numeric(10,4) NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS import_jobs (id uuid PRIMARY KEY,source text NOT NULL,rows_count integer NOT NULL,status text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS audit_log (id bigserial PRIMARY KEY,user_id uuid REFERENCES users(id),action text NOT NULL,resource_id text,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS journey_sessions (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 request jsonb NOT NULL,catalog jsonb NOT NULL DEFAULT '{}',questions jsonb,
 trip_id uuid REFERENCES trips(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS journey_sessions_owner ON journey_sessions(user_id,updated_at DESC);
CREATE TABLE IF NOT EXISTS user_place_visits (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,place_id text NOT NULL,
 visited boolean NOT NULL,visited_at date,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,place_id)
);
CREATE TABLE IF NOT EXISTS place_signals (
 place_id text NOT NULL,kind text NOT NULL CHECK(kind IN ('fame','crowd')),value double precision NOT NULL CHECK(value BETWEEN 0 AND 1),
 source_url text NOT NULL,observed_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 PRIMARY KEY(place_id,kind),CHECK(expires_at>observed_at)
);
CREATE TABLE IF NOT EXISTS user_place_wishes (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,place_id text NOT NULL,
 wanted boolean NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,place_id)
);
CREATE TABLE IF NOT EXISTS user_place_presence (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,place_id text NOT NULL,
 observed_at timestamptz NOT NULL,dwell_seconds integer NOT NULL CHECK(dwell_seconds>=600),
 PRIMARY KEY(user_id,place_id)
);
CREATE TABLE IF NOT EXISTS scenic_parent_checks (
 place_id text PRIMARY KEY,input_hash text NOT NULL,result jsonb NOT NULL,
 checked_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS scenic_parent_checks_expiry ON scenic_parent_checks(expires_at);
CREATE TABLE IF NOT EXISTS scenic_hierarchy_results (
 place_id text PRIMARY KEY,input_hash text NOT NULL,result jsonb NOT NULL,source_hash text NOT NULL,
 checked_at timestamptz NOT NULL DEFAULT now(),review_after timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS scenic_hierarchy_review ON scenic_hierarchy_results(review_after);
CREATE TABLE IF NOT EXISTS scenic_area_geometries (
 place_id text PRIMARY KEY,geometry_geojson jsonb NOT NULL,source_hash text NOT NULL,
 coordinate_system text NOT NULL DEFAULT 'WGS84' CHECK(coordinate_system='WGS84'),
 source_timestamp timestamptz,updated_at timestamptz NOT NULL DEFAULT now()
);
