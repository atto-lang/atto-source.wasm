import test from 'node:test';
import assert from 'node:assert/strict';
import { rejectUnsupportedActorPipeSource } from '../scripts/compile-ores.mjs';
const check = source => rejectUnsupportedActorPipeSource(new TextEncoder().encode(source));

test('Wasm scalar bridge refuses both directions, bare and contiguous bang syntax', () => {
  for(const op of ['pipe','pipe!','rpipe','rpipe!']) {
    for(const [left,right] of [['producer','consumer'],['make_actor()','sink']]) {
      assert.throws(() => check('pub fnc main():int { val graph = '+left+' '+op+' '+right+'; return 0; }'),
        /wasm actor (?:r?pipe)!? source lowering unsupported/,op);
    }
  }
});

test('Wasm scalar bridge never rewrites a reverse-written DATA edge into a forward guest fallback', () => {
  assert.throws(() => check('val producer = 1; val consumer = 2; val g = consumer rpipe! producer;'),
    /wasm actor rpipe! source lowering unsupported/);
  assert.throws(() => check('val p = 1; val c = 2; val g = p pipe! c;'),
    /wasm actor pipe! source lowering unsupported/);
});

test('unsupported standalone and member stop! cannot emit scalar Wasm', () => {
  for(const source of ['stop! worker;', 'actor_ref.stop!();', 'stop!worker;', 'stop!suffix;']) {
    assert.throws(() => check(source), /wasm graceful actor stop! source lowering unsupported/,source);
  }
});

test('a split bang is NOT silently normalized to the contextual bang spelling', () => {
  for(const source of ['fnc stop(x:int):int { return x; }', 'val stop = 1;', 'val rpipe = 1;', 'val pipe = 1;', 'pipe !false']) {
    // The real language compiler must still parse or reject all tokens;
    // source admission only establishes that this was not a contiguous alias.
    assert.doesNotThrow(() => check(source),source);
  }
});

test('token preflight does not reject inert comments, nested comments and string literals', () => {
  for (const source of [
    '// producer pipe! consumer\nfnc main():int{return 42;}',
    '/* consumer rpipe! producer /* stop! actor */ */ fnc main():int{return 42;}',
    '"producer pipe! consumer" "consumer rpipe! producer" "stop! actor"',
    'fnc pipe(x:int):int {return x;}',
    'fnc rpipe(x:int):int {return x;}',
    'fnc main(x:int):int{return x |> add_one;}'
  ]) assert.doesNotThrow(() => check(source),source);
});

test('existing ActorUtils pipe factory remains fail closed; unrelated instance calls stay opaque', () => {
  for(const source of ['ActorUtils::pipe(a,b);','ActorUtils.pipe(a,b);'])
    assert.throws(() => check(source),/wasm actor pipe source lowering unsupported/);
  assert.doesNotThrow(()=>check('object.pipe(1); object.rpipe(2);'));
});
