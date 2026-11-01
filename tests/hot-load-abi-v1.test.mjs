import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UHL1_ABI_VERSION,
  UHL1_INTERFACE,
  queryHotLoadCapabilities,
  stageHotUpgrade,
  commitHotUpgrade,
  acknowledgeEtsHeir,
  UnsupportedHotUpgradeError
} from '../src/hot-load-abi-v1.mjs';

test('Wasm UHL-1 advertises no actor, ETS, supervisor or executable image support', () => {
  const caps = queryHotLoadCapabilities();
  assert.equal(caps.interface, UHL1_INTERFACE);
  assert.equal(caps.abiVersion, UHL1_ABI_VERSION);
  assert.equal(caps.backend, 'wasm');
  assert.equal(caps.adapterKind, 'trusted-broker-only');
  assert.equal(caps.supervisorAuthorityExposedToGuest, false);
  assert.ok(Object.values(caps.featureSupport).every(x => x === false));
  assert.ok(Object.values(caps.executionModes).every(x => x === false));
  assert.equal(caps.maxManifestBytes, 0);
  assert.equal(caps.maxCheckpointBytes, 0);
  assert.equal(caps.maxLiveGenerations, 0);
});

test('capability descriptors are immutable and not reconfigurable by caller', () => {
  const caps = queryHotLoadCapabilities();
  assert.ok(Object.isFrozen(caps));
  assert.ok(Object.isFrozen(caps.featureSupport));
  assert.ok(Object.isFrozen(caps.executionModes));
  assert.throws(() => { caps.featureSupport.etsHeir = true; }, TypeError);
  assert.throws(() => { caps.executionModes.aotToAot = true; }, TypeError);
  assert.equal(queryHotLoadCapabilities().featureSupport.etsHeir, false);
});

test('wrong ABI versions are rejected before capability negotiation', () => {
  for (const wrong of [0, 2, -1, 1n, '1', null, {}, Number.MAX_SAFE_INTEGER])
    assert.throws(() => queryHotLoadCapabilities(wrong), RangeError);
  assert.equal(queryHotLoadCapabilities(1).abiVersion, 1);
});

test('Wasm artifacts and even malicious getter objects cannot stage a live actor', () => {
  let inspected = 0;
  const hostile = new Proxy({}, {
    get() { inspected++; throw Error('guest input inspected'); },
    ownKeys() { inspected++; throw Error('guest keys inspected'); }
  });
  for (let i = 0; i < 1000; i++)
    assert.throws(() => stageHotUpgrade(hostile), e =>
      e instanceof UnsupportedHotUpgradeError && e.code === 'ORES_HOT_UNSUPPORTED');
  assert.equal(inspected, 0);
});

test('forged stale epochs and ETS heir receipts cannot commit', () => {
  const payload = Object.freeze({routeEpoch: 42, actorId: 'foreign',
    supervisorId: 'forged', tableId: 'foreign-table'});
  for (let i = 0; i < 1000; i++) {
    assert.throws(() => commitHotUpgrade(payload, 42), {
      code: 'ORES_HOT_UNSUPPORTED'
    });
    assert.throws(() => acknowledgeEtsHeir(payload, payload), {
      code: 'ORES_HOT_UNSUPPORTED'
    });
  }
  assert.equal(queryHotLoadCapabilities().featureSupport.etsHeir, false);
});

