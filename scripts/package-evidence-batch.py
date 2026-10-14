from pathlib import Path
import hashlib,json,zipfile
root=Path(__file__).resolve().parents[1]
files={name:root/'scripts/osm'/name for name in ['annotations.sql','import_annotations.py','place_service.py','apply_evidence_batch_server.py']}
files['official-three-20261011.json']=root/'data/editorial/official-three-20261011.json'
target=root/'.runtime/evidence-20261011/official-three-20261011.zip'
with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED) as z:
    for name,path in files.items():z.writestr(name,path.read_bytes())
print(json.dumps({'file':str(target),'bytes':target.stat().st_size,'sha256':hashlib.sha256(target.read_bytes()).hexdigest()}))
