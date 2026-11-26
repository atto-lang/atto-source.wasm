import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionContext, captureExecutionCallbackContext, deriveExecutionCallbackContext, currentExecutionCallbackContext, runWithExecutionCallbackContext, isExecutionCallbackContext } from '../src/execution-callback-context.mjs';
const origin = () => createExecutionContext({runtimeDomain: 1n, execution: 2n, dispatch: 3n, generation: 4n});
const sample = () => captureExecutionCallbackContext(origin(), 'IO');
const reject = value => {
  assert.equal(isExecutionCallbackContext(value), false);
  assert.throws(() => runWithExecutionCallbackContext(value, () => assert.fail('entered rejected scope')));
  assert.equal(currentExecutionCallbackContext(), null);
};
test('frozen callback accessor is rejected without invocation', () => {
  let calls = 0;
  const value = {...sample()};
  Object.defineProperty(value, 'execution', {get() { calls++; return 2n; }, enumerable: true});
  reject(Object.freeze(value));
  assert.equal(calls, 0);
});
test('execution accessor is rejected without invocation', () => {
  let calls = 0;
  const value = {...origin()};
  Object.defineProperty(value, 'execution', {get() { calls++; return 2n; }, enumerable: true});
  assert.throws(() => captureExecutionCallbackContext(value, 'IO'));
  assert.equal(calls, 0);
});
test('sparse trace rejected', () => reject({...sample(), traceBoundaries: Array(1)}));
test('trace accessor rejected without invocation', () => {
  let calls = 0;
  const trace = ['IO'];
  Object.defineProperty(trace, '0', {get() { calls++; return 'IO'; }});
  reject({...sample(), traceBoundaries: trace});
  assert.equal(calls, 0);
});
test('foreign trace iterator rejected without invocation', () => {
  let calls = 0;
  const trace = ['IO'];
  trace[Symbol.iterator] = function* () { calls++; yield 'TIMER'; };
  reject({...sample(), traceBoundaries: trace});
  assert.equal(calls, 0);
});
test('mismatched terminal boundary rejected', () => reject({...sample(), traceBoundaries: ['TIMER']}));
test('impossible elision rejected', () => reject({...sample(), traceElided: 1n}));
test('canonical callback retains identity and scope', () => {
  const value = sample();
  runWithExecutionCallbackContext(value, () => assert.equal(currentExecutionCallbackContext(), value));
  assert.equal(currentExecutionCallbackContext(), null);
});
test('worker clone is snapshotted', () => {
  const value = structuredClone(sample());
  runWithExecutionCallbackContext(value, () => {
    const installed = currentExecutionCallbackContext();
    value.execution = 999n;
    value.traceBoundaries[0] = 'TIMER';
    assert.equal(installed.execution, 2n);
    assert.deepEqual(installed.traceBoundaries, ['IO']);
    assert.ok(Object.isFrozen(installed) && Object.isFrozen(installed.traceBoundaries));
  });
});
test('bounded derivation stays valid', () => {
  let value = sample();
  for (let i = 0; i < 10; i++) value = deriveExecutionCallbackContext(value, 'TIMER');
  assert.equal(value.traceBoundaries.length, 8);
  assert.equal(value.traceElided, 3n);
  assert.equal(isExecutionCallbackContext(value), true);
});
