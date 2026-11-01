import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// JSON.parse alone silently keeps only the last occurrence of a duplicated key.
// Every unsupported-source fixture must remain independently testable.
const corpora = [
  ['legacy', new URL('./value-boundary-rejections.json', import.meta.url), 20],
  ['v1', new URL('../contracts/v1/cpu-gpu-nb-unsupported-v1.json', import.meta.url), 10],
  ['v2', new URL('../contracts/v2/cpu-gpu-task-unsupported-v2.json', import.meta.url), 10],
];

function uniqueFixtureIds(raw, label, expectedCount) {
  assert.ok(raw.endsWith('\n'), label + ': missing canonical final LF');
  const parsed = JSON.parse(raw);
  assert.ok(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed),
    label + ': corpus must be a JSON object');
  // These corpora have one top-level string-valued fixture per line. Reading
  // the source keys before JSON.parse discards duplicates prevents shadowing.
  const lines = raw.split('\n').filter(line => /^\s*"/.test(line));
  const keys = lines.map(line => {
    const match = /^\s*"([a-z][a-z0-9-]*)"\s*:\s*"/.exec(line);
    assert.ok(match, label + ': fixture must be a single string entry: ' + line.slice(0, 80));
    return match[1];
  });
  assert.equal(keys.length, expectedCount, label + ': source key count drift');
  assert.equal(new Set(keys).size, keys.length, label + ': duplicate raw JSON case IDs');
  assert.deepEqual([...keys].sort(), Object.keys(parsed).sort(),
    label + ': raw keys differ from parsed keys');
  for (const [key, value] of Object.entries(parsed)) {
    assert.ok(typeof value === 'string' && /\bfnc\s+main\s*\(/.test(value),
      label + ': invalid source payload for ' + key);
    assert.ok(value.length <= 10000, label + ': oversized source payload for ' + key);
  }
  return keys;
}

test('legacy/v1/v2 unsupported-source IDs are disjoint before JSON key normalization', () => {
  const all = [];
  for (const [label, url, count] of corpora) {
    all.push(...uniqueFixtureIds(readFileSync(url, 'utf8'), label, count));
  }
  assert.equal(all.length, 40);
  assert.equal(new Set(all).size, all.length, 'case IDs collided across corpus versions');
});

test('duplicate raw JSON case IDs cannot silently overwrite a negative fixture', () => {
  const duplicate = '{\n  "same": "pub fnc main():int{return 1;}",\n' +
    '  "same": "pub fnc main():int{return 2;}"\n}\n';
  assert.throws(() => uniqueFixtureIds(duplicate, 'duplicate', 2),
    /duplicate raw JSON case IDs/);
});

test('malformed payload and fixture count cannot be treated as parity evidence', () => {
  const nonSource = '{\n  "one": "not a source file"\n}\n';
  assert.throws(() => uniqueFixtureIds(nonSource, 'non-source', 1), /invalid source payload/);
  const missing = '{\n  "one": "pub fnc main():int{return 42;}"\n}\n';
  assert.throws(() => uniqueFixtureIds(missing, 'missing', 2), /source key count drift/);
});
