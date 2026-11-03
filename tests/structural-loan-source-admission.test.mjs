import test from 'node:test';
import assert from 'node:assert/strict';
import {rejectUnsupportedStructuralLoanSource} from '../src/inferred-aggregate-source-admission.mjs';

const bytes=x=>Buffer.from(x,'utf8');
test('deny structural shape loans in any callable parameter position',()=>{
  for(const source of [
    'fnc f(structural {id:int} value)->int{return value.id;}',
    'fnc f(int n, structural {id:int} value)->int{return value.id;}',
    'fnc f(int n, structural Shape value)->int{return value.id;}',
    'fnc f(int n, value: structural {id:int})->int{return value.id;}',
    'fnc f(int n, value: structural Shape)->int{return value.id;}',
    'fnc f()->structural Shape{return create();}',
    'fnc f()->structural {id:int}{return create();}',
    'fnc f(int n, structural (int,int) pair)->int{return n;}',
    'fnc f(int n, /* comment */ structural /* comment */ Shape pair)->int{return n;}',
    'fnc f<T>(int n, structural Shape pair)->int{return n;}',
    'fnc f(int n, structural Shape pair)->int{return n;}',
    'fnc f(int n, value: structural Shape)->int{return n;}'
  ])assert.throws(()=>rejectUnsupportedStructuralLoanSource(bytes(source)),/wasm structural readonly-view ABI unsupported/,source);
});
test('preserve contextual identifiers, strings and comments',()=>{
  for(const source of [
    'fnc structural(int value)->int{return value;}',
    'fnc f(int structural)->int{return structural;}',
    'fnc f()->int { const structural=42; return structural;}',
    'fnc f()->int { return structural(42);}',
    'fnc f()->int { return foo(structural(42));}',
    'fnc f()->int { return foo(42, structural(3));}',
    'fnc f()->int { const s="fnc f(int n, structural Shape v)"; return 42;}',
    "fnc f()->int { const s='structural {id:int}'; return 42;}",
    '/* /* structural {id:int} */ */ fnc f()->int {return 42;}',
    'fnc f()->int {const structuralThing=1;return structuralThing;}',
  ])assert.doesNotThrow(()=>rejectUnsupportedStructuralLoanSource(bytes(source)),source);
});
test('source scanning fails closed for invalid encoding and comment nesting',()=>{
  assert.throws(()=>rejectUnsupportedStructuralLoanSource(Uint8Array.of(0xc0,0xaf)),/encoded data was not valid/i);
  assert.throws(()=>rejectUnsupportedStructuralLoanSource(bytes('/*'.repeat(65)+'*/'.repeat(65))),/nesting exceeded/);
  assert.throws(()=>rejectUnsupportedStructuralLoanSource(bytes('"structural {id:int}')),/unterminated/);
});

test('invalid infer structural constructor is denied before LLVM compiler admission',()=>{
  assert.throws(()=>rejectUnsupportedStructuralLoanSource(bytes('fnc main()->int{const a=infer structural{id:42};return 42;}')),/wasm invalid infer structural constructor/);
});
