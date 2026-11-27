import test from 'node:test';
import assert from 'node:assert/strict';
import {observeGuest,runBounded} from '../scripts/named-recursive-browser-worker.mjs';

// Synthetic modules exercise the observer, never the Atto compiler.
const uleb=n=>{const b=[];do{let x=n&127;n>>>=7;b.push(x|(n?128:0));}while(n);return b;};
const sleb=n=>{const b=[];n=BigInt(n);for(;;){let x=Number(n&127n);n>>=7n;const done=(n===0n&&!(x&64))||(n===-1n&&!!(x&64));b.push(x|(done?0:128));if(done)return b;}};
const section=(id,p)=>[id,...uleb(p.length),...p];
const name=s=>[s.length,...Buffer.from(s)];
const module=(body,result=0x7e,extra=[])=>{
  const code=[0,...body,0x0b];
  return Uint8Array.from([0,97,115,109,1,0,0,0,
    ...section(1,[1,0x60,0,1,result]),...extra,...section(3,[1,0]),
    ...section(6,[1,0x7f,1,0x41,0,0x0b]),
    ...section(7,[2,...name('main'),0,0,...name('panic_code'),3,0]),
    ...section(10,[1,...uleb(code.length),...code])]);
};
const value=n=>module([0x42,...sleb(n)]);
const panic=n=>module([0x41,...sleb(n),0x24,0,0]);
test('full signed i64 values and repeat invocation',async()=>{
  for(const n of [0n,-9223372036854775808n,9223372036854775807n,139583862445n]){
    assert.deepEqual(await runBounded({kind:'guest-control',bytes:value(n),expected:{kind:'value',value:String(n)}}),{kind:'value',value:String(n),repetitions:3});
  }
});
test('typed panic codes 1 and 6 are not ordinary traps',async()=>{
  for(const code of [1,6])assert.deepEqual(await runBounded({kind:'guest-control',bytes:panic(code),expected:{kind:'panic',code}}),{kind:'panic',code});
  assert.throws(()=>observeGuest(panic(1),{kind:'panic',code:6}),/wrong language panic/);
  assert.throws(()=>observeGuest(module([0]),{kind:'panic',code:6}),/wrong language panic/);
});
test('reject wrong result, i32 coercion, bad bytes, compile-only execution',()=>{
  assert.throws(()=>observeGuest(value(42),{kind:'value',value:'43'}),/wrong signed i64/);
  assert.throws(()=>observeGuest(module([0x41,42],0x7f),{kind:'value',value:'42'}),/wrong signed i64/);
  assert.throws(()=>observeGuest(new Uint8Array([1]),{kind:'value',value:'0'}),/invalid guest/);
  assert.throws(()=>observeGuest(value(42),{kind:'compile'}),/must not be instantiated/);
});
test('bounded worker terminates an infinite Wasm loop',async()=>{
  const bytes=module([0x03,0x40,0x0c,0,0x0b,0x42,0]);
  assert.ok(WebAssembly.validate(bytes));
  await assert.rejects(runBounded({kind:'guest-control',bytes,expected:{kind:'value',value:'0'}},500),/E_BROWSER_PROOF_TIMEOUT/);
});
test('worker assertion failure propagates without a pass receipt',async()=>{
  await assert.rejects(runBounded({kind:'guest-control',bytes:value(1),expected:{kind:'value',value:'2'}}),/wrong signed i64/);
});
