import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const contract = JSON.parse(readFileSync(new URL('../contracts/tenant-broker-guest-v1/cases.json', import.meta.url), 'utf8'));
const required = [
  'tenant_aggregate_quota_survives_restart',
  'revoked_capability_denied_at_dispatch',
  'forged_cross_tenant_actorref_denied',
  'authorized_broker_delivery_exactly_once',
  'unrelated_tenant_survives_denial'
];
test('five cases remain identical to receipt gate requirements', () => {
  assert.equal(contract.schema, 'atto.tenant.broker.guest.v1');
  assert.equal(contract.status, 'SPECIFICATION_ONLY_NOT_EXECUTED');
  assert.equal(contract.minimum_distinct_tenants, 2);
  assert.deepEqual(contract.cases.map(c => c.id), required);
});
test('each case requires observable trustworthy broker evidence', () => {
  for (const c of contract.cases) {
    assert.ok(c.precondition.length > 40);
    assert.ok(c.action.length > 40);
    assert.ok(c.expected.length > 40);
    assert.ok(c.must_observe.length >= 4);
    assert.equal(new Set(c.must_observe).size, c.must_observe.length);
  }
});
