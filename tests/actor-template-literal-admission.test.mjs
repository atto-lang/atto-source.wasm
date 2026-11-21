import test from 'node:test';
import assert from 'node:assert/strict';
import {rejectUnsupportedActorPipeSource,assertScalarSourceHasNoImports} from '../scripts/compile-ores.mjs';
const bytes = s => new TextEncoder().encode(s);

test('actor preflight treats ordinary backtick templates as quoted, consistent with import preflight',()=>{
  for(const source of [
    'val s = `producer pipe! consumer`;',
    'val s = `consumer rpipe! producer`;',
    'val s = `stop! worker`;',
    'val s = `import +hidden;`;',
    'val s = `literal escaped \\` pipe! text`;',
  ]) {
    assert.doesNotThrow(()=>assertScalarSourceHasNoImports(bytes(source)),source);
    assert.doesNotThrow(()=>rejectUnsupportedActorPipeSource(bytes(source)),source);
  }
});

test('unterminated backtick source literal fails closed and outer operators remain forbidden',()=>{
  for(const source of ['val s = `producer pipe! consumer;', 'val s = `stop! worker;'])
    assert.throws(()=>rejectUnsupportedActorPipeSource(bytes(source)),/unterminated source literal/,source);
  for(const source of [
    'val s = `pipe!`; val g = producer pipe! consumer;',
    'val s = `rpipe!`; val g = producer rpipe consumer;',
    'val s = `stop!`; stop! worker;'
  ])
    assert.throws(()=>rejectUnsupportedActorPipeSource(bytes(source)),/source lowering unsupported/,source);
});
