import test from 'node:test';
import assert from 'node:assert/strict';
import {lexicalTokensForPreflight as scan} from '../scripts/atto-template-preflight-tokens.mjs';

const tick = String.fromCharCode(96);
const interpolation = source => '${' + source + '}';
const wrap = source => tick + source + tick;
const nested = depth => {
  let source = wrap('x');
  for (let i = 2; i <= depth; i++) source = wrap('outer ' + interpolation(source));
  return source;
};
const comments = depth => wrap(interpolation('/*'.repeat(depth) + 'ignored' + '*/'.repeat(depth) + 'x'));
const braces = depth => wrap(interpolation('{'.repeat(depth) + 'x' + '}'.repeat(depth)));
const substitutions = depth => wrap(interpolation("'x'").repeat(depth));
const valid = [
  ['nested template depth 32', nested(32)],
  ['nested comment depth 128', comments(128)],
  ['nested braces 256', braces(256)],
  ['substitutions 1024', substitutions(1024)],
  ['escaped backtick', wrap('x \\' + tick)],
  ['quoted braces', wrap('x ' + interpolation("'{}'"))],
  ['Unicode hex', wrap('x \\u0061')],
];
const invalid = [
  ['nested template depth 33', nested(33)],
  ['nested comment depth 129', comments(129)],
  ['nested braces 257', braces(257)],
  ['substitutions 1025', substitutions(1025)],
  ['empty interpolation', wrap('x ' + interpolation(''))],
  ['comment-only interpolation', wrap('x ' + interpolation('/*ignored*/'))],
  ['invalid template escape', wrap('x \\q')],
  ['invalid Unicode escape', wrap('x \\u12G4')],
  ['unclosed template', tick + 'x ' + interpolation('name')],
  ['unclosed quote', "'broken"],
];
for (const [name, source] of valid)
  test(name, () => assert.doesNotThrow(() => scan(source)));
for (const [name, source] of invalid)
  test(name, () => assert.throws(() => scan(source)));

test('seeded quote/template lexical stress (4096 inputs)', () => {
  let seed = 0x1832afff;
  const next = () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 0x100000000);
  const fragments = ['plain', '\\n', '\\u0061', '\\\\', '\\$', '\\' + tick,
    interpolation("'ok'"), interpolation('"ok"'), ' space'];
  for (let n = 0; n < 4096; n++) {
    let source = '';
    for (let i = 0, max = 1 + Math.floor(next() * 10); i < max; i++)
      source += fragments[Math.floor(next() * fragments.length)];
    assert.doesNotThrow(() => scan(wrap(source)));
    assert.throws(() => scan(wrap(source + '\\q')));
  }
});
