"""Import a complete POI snapshot atomically into a separate PostgreSQL schema."""
import argparse
import gzip
import json
import os
from pathlib import Path
import uuid
import psycopg
from psycopg.types.json import Jsonb
from download import digest, emit

COLUMNS = ["id", "osm_type", "osm_id", "name", "aliases", "category", "subcategory", "lon", "lat", "geometry_kind", "coordinate_role", "country_code", "province", "city", "opening_hours", "fee", "access", "selectable", "tags"]


def load(snapshot, region, conn, spatial=False):
    if conn.info.transaction_status != psycopg.pq.TransactionStatus.IDLE:
        raise ValueError('Importer requires its own idle database connection')
    metadata = json.loads(snapshot.with_suffix(snapshot.suffix + ".json").read_text(encoding="utf8"))
    if metadata["format"] != "seatraces-osm-poi-v1" or digest(snapshot, "sha256") != metadata["output_sha256"]:
        raise ValueError("Unverified or unsupported POI snapshot")
    if metadata["total"] < 1:
        raise ValueError("Refusing to activate an empty snapshot")
    sql_dir = Path(__file__).parent
    with conn.transaction():
        conn.execute(sql_dir.joinpath("schema.sql").read_text(encoding="utf8"))
        conn.execute(sql_dir.joinpath("relevance.sql").read_text(encoding="utf8"))
        if spatial:
            conn.execute(sql_dir.joinpath("spatial.sql").read_text(encoding="utf8"))
    # End schema locks before the potentially long COPY transaction. Existing
    # active snapshots can remain readable while a new snapshot is staged.
    with conn.transaction():
        conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", ("seatraces-osm:" + region,))
        existing = conn.execute("SELECT id,rows_count,manifest->>'output_sha256' FROM osm.imports WHERE region=%s AND pbf_sha256=%s", (region, metadata["pbf_sha256"])).fetchone()
        if existing:
            if existing[1] != metadata['total'] or existing[2] != metadata['output_sha256']:
                raise ValueError('Same PBF has a different processed artifact; inspect and explicitly migrate the processing version')
            emit("already_imported", region=region, import_id=str(existing[0]), rows=existing[1])
            return existing[1]
        import_id = uuid.uuid4()
        conn.execute("INSERT INTO osm.imports(id,region,pbf_sha256,pbf_timestamp,rows_count,manifest) VALUES(%s,%s,%s,%s,%s,%s)", (import_id,region,metadata["pbf_sha256"],metadata.get("pbf_timestamp") or None,metadata["total"],Jsonb(metadata)))
        count = 0
        with conn.cursor().copy("COPY osm.poi(import_id," + ",".join(COLUMNS) + ",search_text) FROM STDIN") as copier:
            with gzip.open(snapshot, "rt", encoding="utf8") as stream:
                for line in stream:
                    item = json.loads(line)
                    values = [Jsonb(item[x]) if x == "tags" else item.get(x) for x in COLUMNS]
                    search_text = " ".join([item["name"], *item["aliases"], item.get("province") or "", item.get("city") or ""])
                    copier.write_row([import_id, *values, search_text])
                    count += 1
        if count != metadata["total"]:
            raise ValueError("Snapshot row count mismatch; transaction rolled back")
        conn.execute("INSERT INTO osm.active_imports(region,import_id) VALUES(%s,%s) ON CONFLICT(region) DO UPDATE SET import_id=excluded.import_id", (region,import_id))
    conn.execute("ANALYZE osm.poi")
    conn.commit()
    emit("imported", region=region, rows=count, import_id=str(import_id))
    return count


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", type=Path)
    parser.add_argument("--region", required=True)
    parser.add_argument("--postgis", action="store_true")
    parser.add_argument("--local-prototype", action="store_true")
    args = parser.parse_args()
    if args.local_prototype:
        config = json.loads(Path(".runtime/local.json").read_text(encoding="utf8"))
        connection = psycopg.connect(host="127.0.0.1", port=config["port"], dbname="seatraces", user="seatraces", password=config["password"])
    else:
        connection = psycopg.connect(os.environ["OSM_DATABASE_URL"])
    with connection:
        load(args.snapshot, args.region, connection, args.postgis)
