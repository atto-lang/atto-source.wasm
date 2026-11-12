import test from 'node:test';
import assert from 'node:assert/strict';
import {lexicalTokensForPreflight as scan} from '../scripts/atto-template-preflight-tokens.mjs';

test('to_string fnc and method names stay code only inside interpolation',()=>{
 const source = 'pub fnc main():void { val text = `v:${to_string(value)} m:${value.to_string()}`; }';
 const tokens=scan(source);
 assert.equal(tokens.filter(t=>t.id && t.text==='to_string').length,2);
 assert.equal(tokens.filter(t=>t.id && t.text==='value').length,2);
});

test('quoted and escaped to_string text never becomes code tokens',()=>{
 const tokens=scan('val text = "to_string(x)"; val template = `text \\${to_string(x)}`;');
 assert.equal(tokens.filter(t=>t.id && t.text==='to_string').length,0);
});

test('template interpolation remains strict and does not imply String lowering',()=>{
 const good=scan('val value = `prefix ${to_string(42)} suffix`;');
 assert.ok(good.some(t=>t.id && t.text==='to_string'));
 assert.throws(()=>scan('val value = `bad \\q ${to_string(42)}`;'),/invalid template escape/);
 // Host-only lexical preflight is never evidence of typed guest String runtime.
});
