-- 定义业务事件及其关联记录的数据表、索引和关联结构。

CREATE TABLE IF NOT EXISTS analytics_settings (
 id integer PRIMARY KEY CHECK(id=1), started_at timestamptz NOT NULL DEFAULT now(),
 raw_retention_days integer NOT NULL DEFAULT 90 CHECK(raw_retention_days BETWEEN 7 AND 365),
 aggregate_retention_months integer NOT NULL DEFAULT 12 CHECK(aggregate_retention_months BETWEEN 1 AND 60)
);
INSERT INTO analytics_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS product_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 event_type varchar(80) NOT NULL,
 resource_type varchar(24) NOT NULL,
 resource_id varchar(100) NOT NULL,
 entity_version integer,
 flow_id uuid,
 request_id uuid,
 source text NOT NULL CHECK(source IN ('database','client','server')),
 properties jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(properties)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS product_events_user_time ON product_events(user_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS product_events_type_time ON product_events(event_type,created_at DESC);
CREATE INDEX IF NOT EXISTS product_events_time ON product_events(created_at DESC);
CREATE INDEX IF NOT EXISTS product_events_flow ON product_events(user_id,flow_id,created_at);
CREATE INDEX IF NOT EXISTS product_events_resource ON product_events(resource_type,resource_id,event_type);

CREATE OR REPLACE FUNCTION record_product_change() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
 event_name text; kind text; entity text; flow uuid; ver integer;
 props jsonb := '{}'; rid uuid := NULLIF(current_setting('seatraces.request_id',true),'')::uuid;
BEGIN
 flow := NULLIF(current_setting('seatraces.flow_id',true),'')::uuid;
 IF TG_TABLE_NAME='journey_sessions' THEN
   kind:='journey';entity:=NEW.id::text;flow:=NEW.id;
   IF TG_OP='INSERT' THEN event_name:='journey.started';
   ELSIF NEW.trip_id IS DISTINCT FROM OLD.trip_id AND NEW.trip_id IS NOT NULL THEN event_name:='journey.completed';props:=jsonb_build_object('tripId',NEW.trip_id);
   ELSIF OLD.questions IS NULL AND NEW.questions IS NOT NULL THEN event_name:='journey.questions_ready';
   ELSIF NEW.catalog IS DISTINCT FROM OLD.catalog THEN event_name:='journey.candidates_loaded';
   END IF;
 ELSIF TG_TABLE_NAME='trips' THEN
   kind:='trip';entity:=NEW.id::text;flow:=COALESCE(flow,NEW.id);ver:=NEW.version;
   props:=jsonb_build_object('version',NEW.version,'status',NEW.status,'days',jsonb_array_length(CASE WHEN jsonb_typeof(NEW.plan->'days')='array' THEN NEW.plan->'days' ELSE '[]' END));
   IF TG_OP='INSERT' THEN event_name:='trip.saved';
   ELSIF NEW.status IS DISTINCT FROM OLD.status THEN event_name:='trip.status_changed';
   ELSIF NEW.plan IS DISTINCT FROM OLD.plan OR NEW.title IS DISTINCT FROM OLD.title OR NEW.version IS DISTINCT FROM OLD.version THEN event_name:='trip.updated';
   END IF;
 ELSIF TG_TABLE_NAME='citywalk_drafts' THEN
   kind:='citywalk';entity:=NEW.id::text;flow:=NEW.id;
   IF TG_OP='INSERT' THEN event_name:='citywalk.started';END IF;
 ELSIF TG_TABLE_NAME='citywalks' THEN
   kind:='citywalk';entity:=NEW.id::text;flow:=COALESCE(flow,NEW.id);ver:=NEW.version;
   props:=jsonb_build_object('distanceM',NEW.distance_m,'stops',jsonb_array_length(NEW.stops),'verified',NEW.verified_route->>'status'='verified','version',NEW.version);
   IF TG_OP='INSERT' THEN event_name:='citywalk.saved';
   ELSIF NEW.version IS DISTINCT FROM OLD.version OR NEW.stops IS DISTINCT FROM OLD.stops OR NEW.title IS DISTINCT FROM OLD.title THEN event_name:='citywalk.updated';END IF;
 ELSIF TG_TABLE_NAME='user_travel_memory' THEN
   kind:='memory';entity:=NEW.dimension;ver:=NEW.version;
   props:=jsonb_build_object('dimension',NEW.dimension,'source',NEW.source,'confidence',NEW.confidence);
   IF TG_OP='INSERT' THEN event_name:='memory.confirmed';
   ELSIF NEW.version IS DISTINCT FROM OLD.version OR NEW.value IS DISTINCT FROM OLD.value THEN event_name:='memory.confirmed';END IF;
 ELSIF TG_TABLE_NAME='agent_actions' THEN
   kind:='agent';entity:=NEW.id::text;flow:=NEW.conversation_id;
   props:=jsonb_build_object('capability',NEW.capability,'status',NEW.status);
   IF TG_OP='INSERT' THEN event_name:='agent.action_prepared';
   ELSIF NEW.status IS DISTINCT FROM OLD.status THEN event_name:='agent.action_'||NEW.status;END IF;
 END IF;
 IF event_name IS NOT NULL THEN
   INSERT INTO product_events(user_id,event_type,resource_type,resource_id,entity_version,flow_id,request_id,source,properties)
   VALUES(NEW.user_id,event_name,kind,entity,ver,flow,rid,'database',props);
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER product_journey AFTER INSERT OR UPDATE ON journey_sessions FOR EACH ROW EXECUTE FUNCTION record_product_change();
CREATE OR REPLACE TRIGGER product_trip AFTER INSERT OR UPDATE ON trips FOR EACH ROW EXECUTE FUNCTION record_product_change();
CREATE OR REPLACE TRIGGER product_walk_draft AFTER INSERT ON citywalk_drafts FOR EACH ROW EXECUTE FUNCTION record_product_change();
CREATE OR REPLACE TRIGGER product_walk AFTER INSERT OR UPDATE ON citywalks FOR EACH ROW EXECUTE FUNCTION record_product_change();
CREATE OR REPLACE TRIGGER product_memory AFTER INSERT OR UPDATE ON user_travel_memory FOR EACH ROW EXECUTE FUNCTION record_product_change();
CREATE OR REPLACE TRIGGER product_agent_action AFTER INSERT OR UPDATE ON agent_actions FOR EACH ROW EXECUTE FUNCTION record_product_change();
