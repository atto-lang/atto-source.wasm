import test from 'node:test';
import assert from 'node:assert/strict';
import {RECEIPT_PROTOCOL,RECEIPT_OUTCOMES,RECEIPT_CODES,
  assert_send_receipt,assert_send_failure,create_send_receipt,create_send_failure
} from '../src/send-receipt.mjs';

const source={id:'sender',generation:4};
const target={id:'receiver',generation:9};
const route={id:3,source,source_generation:4,target,target_generation:9,actor_id:1};
test('receipt v1 identifies a confirmed recipient handler, without exposing capabilities',()=>{
  const r=create_send_receipt(route,7,'processed','OK');
  assert.deepEqual(r,{protocol:RECEIPT_PROTOCOL,receipt_id:7,route_id:3,
    source:'sender',source_generation:4,target:'receiver',target_generation:9,
    actor_id:1,outcome:'processed',code:'OK'});
  assert.equal(r.route_capability,undefined);
  assert.equal(r.capability,undefined);
  assert.deepEqual(assert_send_receipt(structuredClone(r)),r);
  assert.deepEqual(RECEIPT_OUTCOMES,['processed','rejected','unknown']);
  assert.ok(RECEIPT_CODES.includes('E_ROUTE_TIMEOUT'));
});
test('dispatched but unacknowledged deliveries are unknown, never rejected',()=>{
  const r=create_send_receipt(route,8,'unknown','E_ROUTE_TIMEOUT');
  const f=create_send_failure('E_ROUTE_TIMEOUT','unknown',r,
    [create_send_receipt(route,7,'processed','OK')]);
  assert.equal(f.receipt.outcome,'unknown');
  assert.equal(f.prior_receipts.length,1);
  assert.deepEqual(assert_send_failure(structuredClone(f)),f);
});
test('receipt ABI rejects contradictory success, unbounded history and malformed authority',()=>{
  const valid=create_send_receipt(route,1,'processed','OK');
  for(const patch of [
    {protocol:'unversioned'},{receipt_id:0},{source:'../../other'},
    {target_generation:0},{outcome:'processed',code:'E_ROUTE_TIMEOUT'},
    {outcome:'unknown',code:'OK'},{route_capability:'do not expose'},
  ]) {
    if('route_capability' in patch) {
      // Unknown properties are deliberately stripped from client-visible receipts.
      assert.equal(assert_send_receipt({...valid,...patch}).route_capability,undefined);
    }else assert.throws(()=>assert_send_receipt({...valid,...patch}),/E_RECEIPT_PROTOCOL/);
  }
  const failure=create_send_failure('E_ROUTE_STALE','rejected');
  assert.equal(failure.receipt,null);
  assert.throws(()=>assert_send_failure({...failure,protocol:'wrong'}),/E_RECEIPT_PROTOCOL/);
  assert.throws(()=>assert_send_failure({...failure,prior_receipts:Array(17).fill(valid)}),
    /E_RECEIPT_PROTOCOL/);
  assert.throws(()=>assert_send_failure({...failure,prior_receipts:[
    create_send_receipt(route,2,'unknown','E_ROUTE_CRASH')]}),/E_RECEIPT_PROTOCOL/);
});
