import test from 'node:test';
import assert from 'node:assert/strict';
import {rejectRawSourceControls} from '../src/raw-source-control-policy.mjs';
import {assertScalarSourceHasNoImports,rejectUnsupportedActorPipeSource} from '../scripts/compile-ores.mjs';

const encoder=new TextEncoder();
let seed=0xc0ffee13;
function random(){seed^=(seed<<13);seed^=(seed>>>17);seed^=(seed<<5);return seed>>>0;}
const choose=a=>a[random()%a.length];
const linePrefixes=['', '// harmless\n', '// café 🦀\n', '// harmless\r', '// harmless\u0085', '// harmless\u2028','/* deep /* nested */ */ ', '"harmless import pipe!" ', "'harmless' ", '//\u0085'];
const spacing=[' ','  ','\t','\n','\r','\u0085','\u2028','\u2029'];
const ops=['pipe!','rpipe!','pipe','rpipe'];
const unwantedChars=['\u001b','\u007f','\u061c','\u200e','\u200f','\u202a','\u202b','\u202c','\u202d','\u202e','\u2066','\u2067','\u2068','\u2069'];

test('fuzz: 12000 contextual actor-pipe and stop operators are always denied',()=>{
 for(let i=0;i<12000;i++){
   const op=choose(ops);
   const rhs=choose(['downstream','sink','sink()','(target)','input']);
   const lhs=choose(['producer','source','source()','actor_1']);
   const src=choose(linePrefixes)+`val graph = ${lhs}${choose(spacing)}${op}${choose(spacing)}${rhs};`;
   assert.throws(()=>rejectUnsupportedActorPipeSource(encoder.encode(src)),/source lowering unsupported/,JSON.stringify(src));
 }
 for(let i=0;i<1000;i++){
   const src=choose(linePrefixes)+'stop! worker;';
   assert.throws(()=>rejectUnsupportedActorPipeSource(encoder.encode(src)),/graceful actor stop! source lowering unsupported/,JSON.stringify(src));
 }
});

test('fuzz: 4000 import declarations after real comment terminators are denied',()=>{
  for(let i=0;i<4000;i++){
    const src=choose(linePrefixes)+`import${choose(spacing)}+private/secret;`;
    assert.throws(()=>assertScalarSourceHasNoImports(encoder.encode(src)),/imports require verified complete Wasm module graph/,JSON.stringify(src));
  }
});

test('fuzz: 1500 deceptive controls in comments, strings and code are denied first',()=>{
 for(let i=0;i<1500;i++){
   const ch=choose(unwantedChars);
   const src=choose(['// hidden ','"masked ','val a = 42; '])+ch+' producer pipe! consumer;';
   const bytes=encoder.encode(src);
   assert.throws(()=>rejectRawSourceControls(bytes),/WASM_SOURCE_CONTROL_REJECTED/,JSON.stringify(src));
 }
});

test('fuzz: 4000 unremarkable inputs do not produce false actor/import refusal',()=>{
 for(let i=0;i<4000;i++){
   const benign=choose(['val n = 42;','val label = "pipe! rpipe! stop! import";',
     'fnc pipe(x:int):int {return x;}',
     'val p = input |> transform;','val s = `pipe! rpipe! stop! import`;',
     '// pipe! rpipe! import\nval n = 1;',
     '/* import pipe! stop! /* nested */ */ val n = 42;']);
   const src=choose(linePrefixes)+benign;
   assert.doesNotThrow(()=>{const b=encoder.encode(src);rejectRawSourceControls(b);assertScalarSourceHasNoImports(b);rejectUnsupportedActorPipeSource(b);},JSON.stringify(src));
 }
});
