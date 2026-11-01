#!/usr/bin/env python3
"""Fail-closed derivation check from shared 8-vector JSON to portable host TSV."""
import base64,hashlib,json,pathlib,sys
if len(sys.argv)!=3:
    raise SystemExit('usage: verify_tsv_against_fixture.py fixture.json vectors.tsv')
fixture=pathlib.Path(sys.argv[1]); tsfile=pathlib.Path(sys.argv[2]);
raw=fixture.read_bytes()
expected_blob= 'e9fc97d87dee2670c56ff3abf9e86befbc0f2ff8'
assert hashlib.sha1(f'blob {len(raw)}\0'.encode()+raw).hexdigest()==expected_blob,'fixture hash drift'
obj=json.loads(raw)
assert obj['schema']=='ores-liveview-event-fingerprint-v1' and len(obj['cases'])==8
rows=[row.split('\t') for row in tsfile.read_text(encoding='utf-8').splitlines() if row and not row.startswith('#')]
assert len(rows)==8
for row,case in zip(rows,obj['cases']):
    assert len(row)==6 and row[0]==case['id']
    decoded=[base64.b64decode(row[i],validate=True).decode('utf-8') for i in (1,2,4)]
    assert decoded==[case['user'],case['name'],case['canonical_payload_json']]
    assert row[3]==str(case['base_rev']) and row[5]==case['sha256']
    payload=json.dumps([decoded[0],decoded[1],case['base_rev'],decoded[2]],ensure_ascii=False,separators=(',',':'))
    assert hashlib.sha256(payload.encode()).hexdigest()==row[5],case['id']
print('Source JSON ↔ TSV fidelity: 8/8 golden vectors and SHA-256 digests verified')
