CREATE TABLE IF NOT EXISTS request_traces (
 request_id uuid PRIMARY KEY,trace_id char(32) NOT NULL,method varchar(8) NOT NULL,route varchar(160) NOT NULL,
 status integer NOT NULL,duration_ms double precision NOT NULL,started_at timestamptz NOT NULL,payload jsonb NOT NULL
);
