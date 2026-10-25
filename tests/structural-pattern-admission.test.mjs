import test from 'node:test';
import assert from 'node:assert/strict';
import {rejectUnsupportedStructuralPatternSource} from '../scripts/compile-ores.mjs';
const bytes=s=>Buffer.from(s,'utf8');

test('unsupported named, inline and tuple-nested structural patterns reject before native compilation',()=>{
 for(const source of [
  'match x over on structural Shape matched -> { return 1; } on _ -> { return 0; } end',
  'match row over on structural { id: int } view -> { return view.id; } end',
  'match item over on structural struct{ key: int } view -> { return 1; } end',
  'fnc main(): int { match foo over on structural (int,int) pair -> { return 2; } end }'
 ]) assert.throws(()=>rejectUnsupportedStructuralPatternSource(bytes(source)),/wasm structural pattern lowering unsupported/);
});
test('quotes, nested comments and contextual structural identifier are not patterns',()=>{
 for(const source of [
  '// on structural { id:int }\nfnc main():int{return 1;}',
  '/* outer /* on structural Point */ end */ fnc main():int{return 1;}',
  'fnc main():int { const msg = "on structural Shape x"; return 1; }',
  "fnc structural():int{return 1;} fnc main():int{return structural();}",
  'match value over on int count -> { return 1; } end'
 ]) assert.doesNotThrow(()=>rejectUnsupportedStructuralPatternSource(bytes(source)));
});
test('malformed UTF-8 is rejected rather than parsed permissively',()=>{
 assert.throws(()=>rejectUnsupportedStructuralPatternSource(Uint8Array.from([0xc0,0xaf])),/encoded data was not valid/i);
});
