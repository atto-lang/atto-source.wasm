import test from 'node:test';
import assert from 'node:assert/strict';
import {rejectUnsupportedInferredAggregateSource} from '../src/inferred-aggregate-source-admission.mjs';
const bytes = source => Buffer.from(source,'utf8');
const tick = String.fromCharCode(96);

test('reject unsupported inline/extended aggregate constructors before compilation',()=>{
  const cases=[
    'const p = infer struct{x:1};',
    'const p = infer record{x:1};',
    'const p = infer<Local> struct{x:1};',
    'const p = infer<Local> record{x:1};',
    'const p = infer<Outer<Inner>> struct{x:1};',
    'const p = record{x:1};',
    'const p = struct{x:int}{x:1};',
    'const p = record{...base, x:1};',
    'const p = infer /* comment */ struct /* comment */ {x:1};',
    'const p = infer<Local> /* comment */ record{x:1};',
    'const p = infer struct{...base, x:true};',
    'const p = infer\nrecord{x:1};'
  ];
  for(const source of cases)
    assert.throws(()=>rejectUnsupportedInferredAggregateSource(bytes(source)),
      /wasm inferred aggregate lowering unsupported/,source);
});

test('do not confuse contextual words inside strings, comments, or calls with aggregates',()=>{
  const cases=[
    'fnc struct():int{return 1;}',
    'fnc record():int{return 1;}',
    'const infer = 1;',
    'const x = infer<Int>(5);',
    'fnc main():int { const y = record(5); return y; }',
    '// infer struct{x:1}\nfnc main():int{return 42;}',
    '/* a /* infer<Local> record{x:1} */ done */ fnc main():int{return 42;}',
    'fnc main():int {const s="infer record{x:1}";return 42;}',
    "fnc main():int {const s='infer struct{x:1}';return 42;}",
    'fnc main():int {const s='+tick+'infer struct{x:1}'+tick+';return 42;}'
  ];
  for(const source of cases)
    assert.doesNotThrow(()=>rejectUnsupportedInferredAggregateSource(bytes(source)),source);
});

test('invalid UTF-8 and unterminated comments or strings fail closed',()=>{
  assert.throws(()=>rejectUnsupportedInferredAggregateSource(Uint8Array.of(0xc0,0xaf)),/encoded data was not valid/i);
  for(const source of ['/* infer struct{x:1}', '"infer struct{x:1}', tick+'infer record{x:1}'])
    assert.throws(()=>rejectUnsupportedInferredAggregateSource(bytes(source)),/unterminated/);
});

test('bounded nesting in comments and infer type arguments',()=>{
  const hugeComments='/*'.repeat(65)+'*/'.repeat(65);
  const hugeGenerics='infer'+'<'.repeat(33)+'A'+'>'.repeat(33)+' struct{x:1}';
  assert.throws(()=>rejectUnsupportedInferredAggregateSource(bytes(hugeComments)),/nesting exceeded/);
  assert.throws(()=>rejectUnsupportedInferredAggregateSource(bytes(hugeGenerics)),/nesting exceeded/);
});
