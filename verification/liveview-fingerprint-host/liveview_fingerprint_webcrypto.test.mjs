// Browser/worker WebCrypto host-adapter parity, NOT a Wasm guest test.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
const rows = readFileSync(new URL('./fingerprint-v1.tsv',import.meta.url),'utf8')
  .split(/\r?\n/).filter(s=>s && !s.startsWith('#'));
const b64 = s => new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(s,'base64'));
for(const row of rows){
  const [id,user,event,revision,canonical,digest] = row.split('\t');
  test(`WebCrypto host fingerprint ${id}`,async()=>{
    assert.ok(Number.isSafeInteger(Number(revision)));
    const envelope = JSON.stringify([b64(user),b64(event),Number(revision),b64(canonical)]);
    const hash = Buffer.from(await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode(envelope))).toString('hex');
    assert.equal(hash,digest);
  });
}
test('fingerprint fixture has exactly eight cases',()=>assert.equal(rows.length,8));
