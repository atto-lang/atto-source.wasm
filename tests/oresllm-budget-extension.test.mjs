// HOST-ONLY independent checked-i64 reference; this cannot certify real Oreslang execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(new URL('../contracts/oresllm-parity/v1/budget-extension.json', import.meta.url), 'utf8'));
const EXPECTED = [
  ['budget-headroom','100 - (32 + 16)','52'],
  ['near-max-budget','9223372036854775807 - (2 * 64)','9223372036854775679'],
  ['staged-subtractions','17 - 8 - 3','6'],
  ['negative-product','(-3) * (-7)','21'],
  ['min-plus-zero','-9223372036854775808 + 0','-9223372036854775808']
];
const OVERFLOW = [
  ['max-minus-negative-one','9223372036854775807 - (-1)'],
  ['min-times-negative-one','-9223372036854775808 * -1'],
  ['eager-zero-product-overflow','0 * (9223372036854775807 + 1)']
];
const REJECT = [
  ['unexpected-closing-paren','1 + )'],
  ['missing-closing-paren','(1 + 2'],
  ['adjacent-integers','1 2']
];
const MIN = -(1n << 63n), MAX = (1n << 63n) - 1n;
function checked(n) { if (n < MIN || n > MAX) throw Error('checked i64 overflow'); return n; }
function reference(expression) {
  const tokens = expression.match(/[0-9]+|[()+*-]|\S/g) || [];
  let index = 0;
  function primary() {
    const token = tokens[index++];
    if (token === undefined) throw Error('incomplete expression');
    if (token === '(') {
      const value = addition();
      if (tokens[index++] !== ')') throw Error('unbalanced parentheses');
      return value;
    }
    if (token === '-' || token === '+') {
      if (token === '-' && tokens[index] === '9223372036854775808') {
        index++;
        return MIN;
      }
      const value = primary();
      return checked(token === '-' ? -value : value);
    }
    if (!/^[0-9]+$/.test(token)) throw Error('invalid scalar token');
    return checked(BigInt(token));
  }
  function multiplication() {
    let value = primary();
    while (tokens[index] === '*') {
      index++;
      const right = primary();
      value = checked(value * right);
    }
    return value;
  }
  function addition() {
    let value = multiplication();
    while (tokens[index] === '+' || tokens[index] === '-') {
      const op = tokens[index++];
      const right = multiplication();
      value = checked(op === '+' ? value + right : value - right);
    }
    return value;
  }
  const result = addition();
  if (index !== tokens.length) throw Error('trailing tokens');
  return result;
}
function validate(m) {
  assert.deepEqual(Object.keys(m).sort(),
    ['schema_version','contract','classification','required_backends','positive','checked_overflow','compile_reject'].sort());
  assert.equal(m.schema_version, 1);
  assert.equal(m.contract, 'oresllm-scalar-budget-extension-v1');
  assert.equal(m.classification, 'candidate-not-compiler-execution');
  assert.deepEqual(m.required_backends, ['java','llvm','wasm','cranelift','net']);
  assert.deepEqual(m.positive.map(x => [x.id,x.expression,x.expected_i64]), EXPECTED);
  assert.deepEqual(m.checked_overflow.map(x => [x.id,x.expression]), OVERFLOW);
  assert.deepEqual(m.compile_reject.map(x => [x.id,x.expression]), REJECT);
  const ids = [...m.positive,...m.checked_overflow,...m.compile_reject].map(x => x.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const x of m.positive) assert.deepEqual(Object.keys(x).sort(), ['id','expression','expected_i64'].sort());
  for (const x of [...m.checked_overflow,...m.compile_reject])
    assert.deepEqual(Object.keys(x).sort(), ['id','expression'].sort());
}
test('five-backend budget vector manifest is exact, scoped, and duplicate free', () => validate(manifest));
for (const [id,expression,expected] of EXPECTED)
  test('host reference positive ' + id, () => assert.equal(reference(expression).toString(), expected));
for (const [id,expression] of OVERFLOW)
  test('host checked overflow ' + id, () => assert.throws(() => reference(expression), /overflow/));
for (const [id,expression] of REJECT)
  test('host parser rejection ' + id, () => assert.throws(() => reference(expression)));
test('mutation controls reject drift, duplicate ID, spoofed native evidence and extra fields', () => {
  const copy = () => JSON.parse(JSON.stringify(manifest));
  const d = copy(); d.positive[1].id = d.positive[0].id; assert.throws(() => validate(d));
  const x = copy(); x.positive[0].expected_i64 = '53'; assert.throws(() => validate(x));
  const s = copy(); s.classification = 'verified-native-all-backends'; assert.throws(() => validate(s));
  const e = copy(); e.runtime_authorized = true; assert.throws(() => validate(e));
  const n = copy(); n.compile_reject.pop(); assert.throws(() => validate(n));
  const p = copy(); p.positive[0].unexpected = true; assert.throws(() => validate(p));
});
