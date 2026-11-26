// SOURCE-ONLY verification of the second .atto guest fixture's expected assertions.
// Compiler/guest execution needs separate toolchain-backed CI evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const guest=readFileSync(new URL('./fixtures/core-types-v1/edge-matrix-positive.atto',import.meta.url),'utf8');
const MIN=-(1n<<63n),MAX=(1n<<63n)-1n;
const limits=new Map([
 ['fits_i8',[-128n,127n]],['fits_i16',[-32768n,32767n]],
 ['fits_i32',[-2147483648n,2147483647n]],['fits_i64',[MIN,MAX]],
 ['fits_u8',[0n,255n]],['fits_u16',[0n,65535n]],
 ['fits_u32',[0n,4294967295n]],['fits_u64',[0n,MAX]]
]);
function evalSourceArg(value){
  value=value.trim();
  const m=/^(types\.int_(min|max)_value\(\))(?:\s*([+-])\s*(\d+))?$/.exec(value);
  if(m){
    const base=m[2]==='min'?MIN:MAX;
    return base+(m[3]==='-'?-1n:1n)*BigInt(m[4]??0);
  }
  assert.match(value,/^-?(?:0|[1-9][0-9]*)$/,'unexpected source expression');
  return BigInt(value);
}
function verify(body){
  assert.match(body,/import \* as types from "\.\.\/\.\.\/\.\.\/core\/types\.atto";/);
  assert.match(body,/pub fnc main\(\) -> int \{/);
  const expressions=[...body.matchAll(/^\s*if (!?)types\.(fits_[iu](?:8|16|32|64))\(([^;\n]+)\); do return (\d+); fi$/gm)];
  assert.ok(expressions.length>=60,'guest must cover at least sixty cases');
  const source=body.replace(/\/\/[^\r\n]*/g,'');
  const withoutAssertions=source.replace(/^\s*if (!?)types\.(fits_[iu](?:8|16|32|64))\(([^;\n]+)\); do return (\d+); fi$/gm,'')
    .replace(/import \* as types from "\.\.\/\.\.\/\.\.\/core\/types\.atto";/,'')
    .replace(/pub fnc main\(\) -> int \{/,'').replace(/return 0;/,'').replace(/\}/g,'').trim();
  assert.equal(withoutAssertions,'','unreviewed statement in guest matrix');
  const cases=new Map([...limits.keys()].map(key=>[key,{accepted:0,rejected:0}]));
  let next=1;
  for(const [,neg,name,raw,number] of expressions){
    assert.equal(Number(number),next++,'branch error codes must be sequential and unique');
    const x=evalSourceArg(raw);
    assert.ok(x>=MIN&&x<=MAX,'guest input literal must fit signed-int domain');
    const [lo,hi]=limits.get(name);
    const actual=x>=lo&&x<=hi;
    assert.equal(actual,neg==='!',name+'('+raw+') matrix expectation was inverted');
    cases.get(name)[actual?'accepted':'rejected']++;
  }
  assert.equal(cases.size,8);
  for(const [name,counts] of cases){
    assert.ok(counts.accepted>=1,name+' needs admitted cases');
    assert.ok(counts.rejected>=1||name==='fits_i64',name+' needs rejected cases');
  }
  return expressions.length;
}
test('second compiled guest matrix has independent boundary expectations',()=>{
  assert.ok(verify(guest)>=60);
});
test('source-only matrix mutation controls fail for switched expected outcome and duplicate assertion',()=>{
  assert.throws(()=>verify(guest.replace('if !types.fits_i8(-128)', 'if types.fits_i8(-128)')));
  assert.throws(()=>verify(guest.replace('return 2;', 'return 1;')));
  assert.throws(()=>verify(guest.replace('4294967295','4294967296')));
  assert.throws(()=>verify(guest+'\\nimport * as sys from "std/fs";\\n'));
});
