// Strict SOURCE-ONLY contract oracle: not compiled Atto or AOT evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../core/types.atto',import.meta.url),'utf8');
const fixtureRoot=new URL('./fixtures/core-types-v1/',import.meta.url);
const positive=readFileSync(new URL('edge-positive.atto',fixtureRoot),'utf8');
const MIN=-(1n<<63n),MAX=(1n<<63n)-1n;
const ranges={
  fits_i8:[-128n,127n],fits_i16:[-32768n,32767n],
  fits_i32:[-2147483648n,2147483647n],fits_i64:[MIN,MAX],
  fits_u8:[0n,255n],fits_u16:[0n,65535n],
  fits_u32:[0n,4294967295n],fits_u64:[0n,MAX]
};
const widths={int_value_bits:64n,bool_value_bits:1n,byte_value_bits:8n,
  int_min_value:MIN,int_max_value:MAX};
const names=[...Object.keys(widths),...Object.keys(ranges)];
function parseSource(raw){
  const src=raw.replace(/\/\/[^\r\n]*/g,'').trim();
  assert.match(src,/^use namespace types;\s/);
  assert.doesNotMatch(src,/\bdefine\s+(?:pub\s+)?module\b/);
  assert.doesNotMatch(src,/\b(import|alloc|std|ffi|extern|host|reflect|await|spawn|unsafe|new|rt)\b|\busing\s+/);
  const decl=/pub fnc ([a-z][a-z_0-9]*)\((int value)?\) -> (int|bool) \{\s*return ([^;{}]+);\s*\}/g;
  const matches=[...src.matchAll(decl)];
  const remaining=src.replace(decl,'').replace(/^use namespace types;\s*/,'').trim();
  assert.equal(remaining,'','non-reference code must be reviewed rather than guessed');
  assert.equal(matches.length,names.length);
  const result=new Map();
  for(const [,name,param,type,expression] of matches){
    assert.ok(names.includes(name)&&!result.has(name),name);
    assert.equal(type,Object.hasOwn(ranges,name)?'bool':'int',name);
    assert.equal(Boolean(param),Object.hasOwn(ranges,name),name);
    result.set(name,expression.trim());
  }
  assert.deepEqual([...result.keys()].sort(),[...names].sort());
  return result;
}
function literal(expr){
  const m=/^(-?\d+)(?:\s*-\s*(\d+))?$/.exec(expr);
  assert.ok(m,'invalid constant: '+expr);
  return BigInt(m[1])-BigInt(m[2]??'0');
}
function evaluate(defs){
  const functions={};
  for(const name of Object.keys(ranges)){
    const expression=defs.get(name);
    if(name==='fits_i64'){
      assert.equal(expression,'true');functions[name]=()=>true;
    }else if(name==='fits_u64'){
      const m=/^value\s*>=\s*(-?\d+)$/.exec(expression);
      assert.ok(m,name);const lo=BigInt(m[1]);functions[name]=x=>x>=lo;
    }else{
      const m=/^value\s*>=\s*(-?\d+)\s*&&\s*value\s*<=\s*(-?\d+)$/.exec(expression);
      assert.ok(m,name);const lo=BigInt(m[1]),hi=BigInt(m[2]);
      assert.ok(lo<=hi);functions[name]=x=>x>=lo&&x<=hi;
    }
  }
  return functions;
}
function check(raw){
  const definitions=parseSource(raw),computed=evaluate(definitions);
  for(const [name,expected] of Object.entries(widths))
    assert.equal(literal(definitions.get(name)),expected,name);
  const vectors=[MIN,MIN+1n,-9007199254740993n,-4294967296n,-2147483649n,
    -32769n,-129n,-128n,-1n,0n,1n,127n,128n,255n,256n,32767n,
    32768n,65535n,65536n,2147483647n,2147483648n,4294967295n,
    4294967296n,9007199254740993n,MAX-1n,MAX];
  let checks=0;
  for(const [name,[lo,hi]] of Object.entries(ranges)){
    for(const x of new Set([...vectors,lo,hi,lo>MIN?lo-1n:lo,hi<MAX?hi+1n:hi])){
      assert.equal(computed[name](x),x>=lo&&x<=hi,name+'('+x+')');
      checks++;
    }
  }
  return checks;
}
test('actual .atto source is freestanding and 13 exports match the public contract',()=>{
  assert.equal(Object.keys(ranges).length,8);
  assert.equal(names.length,13);
  assert.ok(check(source)>=26*8);
});
test('mutated boundaries, spoofed exports and hosted imports are rejected',()=>{
  const variants=[
    source.replace('value <= 127','value <= 128'),
    source.replace('value >= 0; // Only checks signed-int','value >= -1; // Only checks signed-int'),
    source.replace('return true; // int is an i64','return false; // int is an i64'),
    source.replace('use namespace types;','use namespace hostile;'),
    source.replace('pub fnc fits_i8','pub fnc fits_i16'),
    source+'\nimport * as fs from "std/fs";'
  ];
  for(const changed of variants){assert.notEqual(changed,source);assert.throws(()=>check(changed));}
});
test('positive linked fixture and all eight compiler-negative fixtures are present',()=>{
  assert.match(positive,/import \* as types from "\.\.\/\.\.\/\.\.\/core\/types\.atto";/);
  assert.match(positive,/pub fnc main\(\) -> int/);
  for(const name of names)assert.ok(positive.includes('types.'+name+'('),name);
  const required=[
    ['void-value-negative.atto',/let void invalid/],
    ['void-return-negative.atto',/fnc bad\(\) -> void\s*\{\s*return 7;/],
    ['bool-truthiness-negative.atto',/if 1; do/],
    ['i64-literal-overflow-negative.atto',/9223372036854775808/],
    ['wrong-arg-negative.atto',/types\.fits_u8\(true\)/],
    ['u64-outside-int-negative.atto',/types\.fits_u64\(18446744073709551615\)/],
    ['namespace-duplicate-negative.atto',/use namespace wrong;/],
    ['namespace-late-negative.atto',/use namespace late;/]
  ];
  for(const [file,pattern] of required){
    const body=readFileSync(new URL(file,fixtureRoot),'utf8');
    assert.match(body,pattern);
    assert.match(body,/pub fnc main\(\) -> int/);
  }
});