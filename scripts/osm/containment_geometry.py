"""Streaming full geometries from existing PBFs; no network and no synthetic boundaries."""
from collections import Counter
import gzip
import json
from pathlib import Path
import shutil
import time


def extract_geometries(source, cache, fingerprint, emit, *, disk_index=True):
    import osmium
    from shapely import from_wkb
    from shapely.geometry import Polygon, LineString
    from extract import KEYS, properties
    target = cache / (source['pbf_sha256'] + '-' + fingerprint[:12] + '.jsonl.gz')
    receipt = target.with_suffix('.receipt.json')
    if target.exists() and receipt.exists():
        return target, json.loads(receipt.read_text(encoding='utf8'))
    partial = target.with_suffix('.partial')
    locations = cache / ('locations-' + source['region'] + '.idx')
    # Index is a disposable node-coordinate cache, never a source or result file.
    if locations.exists():
        locations.unlink()
    counts, issues = Counter(), Counter()
    factory = osmium.geom.WKBFactory()
    storage='sparse_file_array,'+str(locations) if disk_index else 'flex_mem'
    processor = osmium.FileProcessor(source['path']).with_locations(storage).with_areas().with_filter(osmium.filter.KeyFilter(*KEYS))
    last_log = time.monotonic()
    try:
        with gzip.open(partial, 'wt', encoding='utf8', compresslevel=3) as output:
            for obj in processor:
                if obj.is_node() or obj.is_relation() or (obj.is_area() and obj.from_way()):
                    continue
                tags = dict(obj.tags)
                if properties(tags) is None:
                    continue
                try:
                    if obj.is_way():
                        coords = [(n.lon,n.lat) for n in obj.nodes if n.location.valid()]
                        if len(coords)!=len(obj.nodes) or len(coords)<2:
                            issues['incomplete_way']+=1;continue
                        # area=no remains a line, never an enclosing scenic polygon.
                        geom = Polygon(coords) if obj.is_closed() and len(coords)>=4 and tags.get('area')!='no' else LineString(coords)
                        oid = 'osm:way/'+str(obj.id)
                    else:
                        geom = from_wkb(factory.create_multipolygon(obj))
                        oid = 'osm:relation/'+str(obj.orig_id())
                    if geom.is_empty or not geom.is_valid:
                        issues['invalid_geometry']+=1;continue
                    if geom.bounds[2]-geom.bounds[0]>180:
                        issues['antimeridian_needs_review']+=1;continue
                    output.write(json.dumps({'id':oid,'wkb':geom.wkb_hex,'version':obj.version},separators=(',',':'))+'\n')
                    counts[geom.geom_type]+=1
                except (RuntimeError,ValueError):
                    issues['geometry_error']+=1
                if time.monotonic()-last_log>20:
                    if shutil.disk_usage(cache).free<3*1024**3:
                        raise RuntimeError('Disk reserve reached during geometry extraction')
                    emit('extract_geometry',region=source['region'],geometries=sum(counts.values()))
                    last_log=time.monotonic()
        partial.replace(target)
        result=dict(counts=dict(counts),issues=dict(issues),total=sum(counts.values()),sourceHash=source['pbf_sha256'])
        receipt.write_text(json.dumps(result,indent=2),encoding='utf8')
        return target,result
    finally:
        # Closing the processor releases disk-backed indexes on Windows too.
        processor.with_locations(None)
        del processor
        import gc
        gc.collect()
        if locations.exists():
            locations.unlink()


if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',type=Path,required=True)
    parser.add_argument('--cache',type=Path,required=True)
    parser.add_argument('--fingerprint',required=True)
    args=parser.parse_args()
    source=json.loads(args.source.read_text(encoding='utf8'))
    def progress(phase,**details):
        print(json.dumps(dict(phase=phase,**details)),flush=True)
    path,result=extract_geometries(source,args.cache,args.fingerprint,progress)
    print(json.dumps(dict(path=str(path),**result)),flush=True)
