ALTER TABLE users ADD COLUMN IF NOT EXISTS analytics_excluded boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS operation_navigation_time ON operation_events(created_at,user_id) WHERE kind='navigation';
CREATE INDEX IF NOT EXISTS trips_created_owner ON trips(created_at,user_id);
CREATE INDEX IF NOT EXISTS citywalks_created_owner ON citywalks(created_at,user_id);
CREATE INDEX IF NOT EXISTS product_events_agent_action ON product_events(user_id,resource_id,created_at) WHERE resource_type='agent';
