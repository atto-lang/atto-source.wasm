import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {admitLiteralSource,compileStaticFacts} from '../scripts/static-facts-v0.mjs';
const fixture=Buffer.from('pub fnc main(): int { return 42; }\n');
test('source bytes admitted only for conservative literal-main Wasm subset',()=>{
  assert.equal(admitLiteralSource(fixture),
    'sha256:'+createHash('sha256').update(fixture).digest('hex'));
  assert.throws(()=>admitLiteralSource(Buffer.from('fnc main():int{return worker();}')),/unsupported/);
  assert.throws(()=>admitLiteralSource(Buffer.from('pub fnc main():int{while true {}return 42;}')),/unsupported/);
  assert.throws(()=>admitLiteralSource(Buffer.concat([fixture,Buffer.from('fnc backdoor():int{return 7;}')])),/unsupported/);
  assert.throws(()=>admitLiteralSource(Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),fixture])),/BOM/);
  assert.throws(()=>admitLiteralSource(Buffer.from([0xff,0xfe])),/UTF-8/);
  assert.throws(()=>admitLiteralSource(Buffer.alloc(1_048_577,32)),/oversized/);
});
test('live Wasm facts require explicit absolute trusted compiler/source paths',async()=>{
  await assert.rejects(()=>compileStaticFacts({compiler:'llvmc',source:'input.ores'}),/absolute/);
});
