import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {checkedUnwrapFixtures, verifyCheckedUnwrapFixture, verifyCheckedUnwrapExecution} from '../src/checked-unwrap-fixtures.mjs';

for (const [id, blob, stdout] of checkedUnwrapFixtures) {
  test(id + ': exact source and fail-closed outcome oracle', () => {
    const bytes = readFileSync(new URL('./fixtures/checked-unwrap-v6/' + id + '.atto', import.meta.url));
    assert.equal(verifyCheckedUnwrapFixture(id, bytes)[1], blob);
    assert.throws(() => verifyCheckedUnwrapFixture(id, Buffer.concat([bytes, Buffer.from(' ')])), /blob mismatch/);
    const valid = {ok:true, panic:0, value:42n, stdout};
    assert.doesNotThrow(() => verifyCheckedUnwrapExecution(id, valid));
    for (const override of [{ok:false}, {panic:1}, {panic:undefined}, {value:42}, {value:0n}, {stdout:stdout+'extra'}])
      assert.throws(() => verifyCheckedUnwrapExecution(id, {...valid, ...override}), /outcome mismatch/);
  });
}
test('unknown fixture and mutable oracle fail closed', () => {
  assert.throws(() => verifyCheckedUnwrapFixture('../escape', new Uint8Array()), /unknown/);
  assert.throws(() => verifyCheckedUnwrapExecution('unknown', {ok:true, panic:0, value:42n, stdout:''}), /mismatch/);
  assert.ok(Object.isFrozen(checkedUnwrapFixtures));
  assert.ok(checkedUnwrapFixtures.every(Object.isFrozen));
});
