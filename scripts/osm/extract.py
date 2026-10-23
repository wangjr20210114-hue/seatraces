"""从 OSM PBF 中提取带来源信息的地点快照。"""
import argparse
from collections import Counter
import gzip
import json
from pathlib import Path
import shutil
import time
import osmium
from shapely.geometry import LineString, Polygon
from shapely import from_wkb
from download import digest, emit
from place_policy import display_name, clean_text

KEYS = ("tourism", "historic", "leisure", "amenity", "shop", "craft", "office", "place", "natural", "waterway", "aeroway", "public_transport", "railway", "highway")


def classify(tags):
    if any(tags.get(k) not in (None, "no", "false", "0") for k in ("disused", "abandoned", "demolished", "razed")):
        return None
    tourism = tags.get("tourism")
    if tourism in ("hotel", "motel", "guest_house", "hostel", "apartment", "chalet", "camp_site", "caravan_site", "alpine_hut", "wilderness_hut"):
        return "accommodation"
    if tourism and tourism not in ("no", "information"):
        return "attraction"
    if tags.get("historic") and tags["historic"] not in ("no", "yes"):
        return "heritage"
    if tags.get("railway") in ("station", "halt", "tram_stop") or tags.get("public_transport") in ("station", "platform") or tags.get("highway") == "bus_stop" or tags.get("aeroway") in ("aerodrome", "terminal"):
        return "transport"
    amenity = tags.get("amenity")
    if amenity in ("restaurant", "cafe", "fast_food", "food_court", "bar", "pub", "ice_cream"):
        return "food"
    if amenity in ("bus_station", "ferry_terminal", "taxi", "bicycle_rental", "car_rental", "parking", "charging_station"):
        return "transport"
    if amenity in ("shelter", "toilets", "drinking_water", "bench", "shower") or tags.get("highway") in ("services", "rest_area"):
        return "rest"
    if amenity == "place_of_worship":
        return "heritage"
    if amenity or tourism == "information":
        return "service"
    if tags.get("shop"):
        return "shopping"
    if tags.get("place") in ("city", "town", "village", "hamlet", "suburb", "quarter", "neighbourhood", "island", "islet", "locality"):
        return "settlement"
    if tags.get("natural") in ("peak", "beach", "cave_entrance", "spring", "water", "wood", "bay", "volcano", "hot_spring", "waterfall") or tags.get("waterway") == "waterfall":
        return "nature"
    if tags.get("leisure"):
        return "leisure"
    if tags.get("office") or tags.get("craft"):
        return "service"
    return None


def properties(tags):
    category = classify(tags)
    if not category:
        return None
    name = display_name(None,tags)
    if not name:
        return None
    aliases = sorted(set(v for k, value in tags.items() if k.startswith("name:") or k in ("name", "alt_name", "short_name", "old_name", "official_name") for raw in value.split(";") if (v:=clean_text(raw)) and v != name))
    return {"name": name, "aliases": aliases, "category": category,
            "subcategory": next((tags[k] for k in KEYS if k in tags), ""),
            "country_code": tags.get("addr:country") or tags.get("ISO3166-1:alpha2"),
            "province": tags.get("addr:province") or tags.get("addr:state"),
            "city": tags.get("addr:city"), "opening_hours": tags.get("opening_hours"),
            "fee": tags.get("fee"), "access": tags.get("access"),
            "selectable": tags.get("access") not in ("private", "no"), "tags": tags}


def extract(pbf, output, cache, reserve_gib):
    output.parent.mkdir(parents=True, exist_ok=True)
    cache.parent.mkdir(parents=True, exist_ok=True)
    if cache.exists():
        raise ValueError("Use a new cache file per extraction; an old cache must be inspected first")
    if shutil.disk_usage(output.parent).free < reserve_gib * 1024**3 + pbf.stat().st_size * 2:
        raise RuntimeError("Insufficient disk reserve for geometry processing")
    partial = output.with_suffix(output.suffix + ".part")
    counts, objects, issues = Counter(), Counter(), Counter()
    factory = osmium.geom.WKBFactory()
    processor = osmium.FileProcessor(str(pbf)).with_locations("sparse_file_array," + str(cache)).with_areas().with_filter(osmium.filter.KeyFilter(*KEYS))
    timestamp = processor.header.get("osmosis_replication_timestamp")
    started, last_log = time.monotonic(), time.monotonic()
    with gzip.open(partial, "wt", encoding="utf8", compresslevel=3) as target:
        for obj in processor:
            if obj.is_relation() or (obj.is_area() and obj.from_way()):
                continue
            tags = dict(obj.tags)
            row = properties(tags)
            if row is None:
                continue
            try:
                if obj.is_node():
                    if not obj.location.valid():
                        issues["invalid_node_location"] += 1
                        continue
                    lon, lat = obj.lon, obj.lat
                    kind, osm_type, osm_id = "Point", "node", obj.id
                elif obj.is_way():
                    coords = [(n.lon, n.lat) for n in obj.nodes if n.location.valid()]
                    if len(coords) != len(obj.nodes) or len(coords) < 2:
                        issues["incomplete_way"] += 1
                        continue
                    if obj.is_closed() and len(coords) >= 4:
                        geometry = Polygon(coords)
                        if not geometry.is_valid:
                            issues["invalid_polygon"] += 1
                            continue
                        point = geometry.representative_point()
                    else:
                        geometry = LineString(coords)
                        point = geometry.interpolate(0.5, normalized=True)
                    lon, lat = point.x, point.y
                    kind, osm_type, osm_id = geometry.geom_type, "way", obj.id
                elif obj.is_area():
                    geometry = from_wkb(factory.create_multipolygon(obj))
                    if geometry.is_empty or not geometry.is_valid:
                        issues["invalid_relation_polygon"] += 1
                        continue
                    point = geometry.representative_point()
                    lon, lat = point.x, point.y
                    kind, osm_type, osm_id = geometry.geom_type, "relation", obj.orig_id()
                else:
                    continue
            except (RuntimeError, ValueError) as error:
                issues[type(error).__name__] += 1
                continue
            if not (-180 <= lon <= 180 and -90 <= lat <= 90):
                issues["invalid_coordinate"] += 1
                continue
            row.update({"id": f"osm:{osm_type}/{osm_id}", "osm_type": osm_type, "osm_id": osm_id,
                        "lon": lon, "lat": lat, "geometry_kind": kind,
                        "coordinate_role": "mapped_point" if osm_type == "node" else "representative_point_not_entrance",
                        "source_url": f"https://www.openstreetmap.org/{osm_type}/{osm_id}"})
            target.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
            counts[row["category"]] += 1
            objects[osm_type] += 1
            if time.monotonic() - last_log > 15:
                if shutil.disk_usage(output.parent).free < reserve_gib * 1024**3:
                    raise RuntimeError("Disk reserve reached during extraction")
                emit("extracting", rows=sum(counts.values()), seconds=round(time.monotonic()-started))
                last_log = time.monotonic()
    partial.replace(output)
    manifest = {"format": "seatraces-osm-poi-v1", "path": output.name, "pbf_timestamp": timestamp,
                "pbf_sha256": digest(pbf, "sha256"), "output_sha256": digest(output, "sha256"),
                "counts": dict(counts), "objects": dict(objects), "geometry_issues": dict(issues),
                "total": sum(counts.values()), "license": "ODbL-1.0", "attribution": "© OpenStreetMap contributors",
                "note": "Named POI index. Raw PBF retains all objects. Missing tags stay null; no facts, administrative boundaries or entrances inferred."}
    output.with_suffix(output.suffix + ".json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf8")
    emit("extracted", **manifest)
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pbf", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--reserve-gib", type=float, default=8)
    args = parser.parse_args()
    extract(args.pbf.resolve(), args.output.resolve(), args.cache.resolve(), args.reserve_gib)
