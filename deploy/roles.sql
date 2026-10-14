-- Execute with psql variable app_password supplied securely by the deployer.
-- Run schema.sql and postgis.sql as database owner BEFORE granting privileges.
CREATE ROLE seatraces_app LOGIN PASSWORD :'app_password';
GRANT CONNECT ON DATABASE seatraces TO seatraces_app;
GRANT USAGE ON SCHEMA public TO seatraces_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO seatraces_app;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO seatraces_app;
ALTER DEFAULT PRIVILEGES FOR ROLE seatraces_owner IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO seatraces_app;
ALTER DEFAULT PRIVILEGES FOR ROLE seatraces_owner IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO seatraces_app;
