// Source-only admission. This is NOT guest compilation or borrow semantics.
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const source = path => readFileSync(new URL("../" + path, import.meta.url),"utf8");
const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//g,"").replace(/\/\/[^\n]*/g,"");
const core = ["stdlib/core/convert.atto","stdlib/core/fmt.atto"];
test("core never touches dynamic text, heap, IO or host runtime",()=>{
  for(const path of core){
    const code=stripComments(source(path));
    assert.match(code,/define module [a-z_]+ as/);
    assert.doesNotMatch(code,/\b(?:String|Array|new|arr|codepoints|malloc|alloc|actor|spawn|await|process|stdio|ffi)\b/);
    assert.doesNotMatch(code,/\brt\s+(?:borrow|take|share|copy)\b/);
    assert.match(code,/Result<[^>]+,\s*int>/);
  }
});
test("text-producing methods only appear in alloc tier",()=>{
  for(const path of ["stdlib/alloc/text_convert.atto","stdlib/alloc/text_fmt.atto"]){
    assert.match(stripComments(source(path)),/\bString\b/);
  }
  assert.match(source("stdlib/alloc/text_convert.atto"),/\.codepoints\(\)/);
  assert.match(source("stdlib/alloc/text_fmt.atto"),/pub fnc format_int\(/);
});
test("collection loans are read-only and outputs newly allocated",()=>{
  const code=stripComments(source("stdlib/std/collections.atto"));
  assert.match(code,/borrow Array<int> values/);
  assert.match(code,/borrow Array<int> left,\s*borrow Array<int> right/);
  assert.doesNotMatch(code,/borrow mut Array<int>/);
  assert.doesNotMatch(code,/\b(?:values|left|right)\.(?:set|add|remove|clear|push|pop)\(/);
  assert.doesNotMatch(code,/is_sorted_int\s*\(\s*(?:values|left|right)\s*\)/,
    "do not create implicit nested reborrows of collection inputs");
  assert.doesNotMatch(code,/\brt\s+(?:share|deref)\b/);
  assert.match(code,/new Array<int>\(\)/);
  const bound=code.indexOf("values.size > 4096"), alloc=code.indexOf("new Array<int>()");
  assert.ok(bound>=0&&alloc>bound,"CPU budget must precede allocation");
  assert.match(code,/return Ok\(rt take output\)/);
});
test("borrow fixtures are explicitly unexecuted semantic candidates",()=>{
  const manifest=JSON.parse(source("tests/fixtures/core-alloc-ownership/manifest.json"));
  assert.equal(manifest.status,"NOT_EXECUTED");
  for(const item of manifest.cases){
    assert.match(item.path,/^tests\/fixtures\/core-alloc-ownership\/[a-z_]+\.atto$/);
    const program=source(item.path);
    assert.match(program,/define module borrow_fixture as/);
    assert.match(program,/borrow Array<int>/);
    if(item.expected==="reject"){
      assert.equal(item.evidenceRequired,"semantic-ownership-diagnostic");
      assert.notEqual(item.diagnostic,"SYNTAX_ERROR");
    }
  }
});
