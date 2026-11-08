import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {runIsolatedCoreGuest} from '../src/isolated-runner.mjs';

// Real validated Wasm modules, not JavaScript spin loops or mocked callbacks.
// A zero-import ()->i64 function, private memory 1..2 pages and exactly two
// exports. The loop executes "loop { br 0 }" forever unless host termination
// succeeds. This is worker kill proof, NOT Wasmtime fuel or guest cooperate.
const prefix = '0061736d010000000105016000017e03020100050401010102071102046d61696e0000066d656d6f72790200';
const looping = Uint8Array.from(Buffer.from(prefix + '0a0b01090003400c000b42000b', 'hex'));
const benign = Uint8Array.from(Buffer.from(prefix + '0a06010400422a0b', 'hex'));

test('unbounded Wasm loop is terminated; next isolated worker is still usable',
  {timeout: 10_000}, async () => {
    assert.equal(WebAssembly.validate(looping), true, 'infinite loop is well-formed Wasm');
    assert.equal(WebAssembly.validate(benign), true, 'benign module is valid Wasm');

    await assert.rejects(
      runIsolatedCoreGuest(looping, {timeoutMs: 250}),
      /guest execution deadline exceeded/);

    // The previous worker must be TERMINATED before the quota is released.
    // A fresh worker must not inherit the previous guest heap or execution.
    const result = await runIsolatedCoreGuest(benign, {timeoutMs: 5000});
    assert.equal(result.value, 42n);
    assert.equal(result.admission.imports, 0);
    assert.equal(result.admission.memoryMaximumPages, 2);
  });

test('repeated runaway worker termination does not leak worker admissions',
  {timeout: 15_000}, async () => {
    // Every call must await actual worker termination before releasing its
    // concurrency credit; a loop in one incarnation cannot poison the next.
    for (let attempt = 0; attempt < 6; attempt++) {
      await assert.rejects(runIsolatedCoreGuest(looping, {timeoutMs: 250}),
        /guest execution deadline exceeded/);
    }
    const recovered = await runIsolatedCoreGuest(benign, {timeoutMs: 5000});
    assert.equal(recovered.value, 42n);
  });

test('pinned exact input bytes distinguish the approved worker program',
  {timeout: 10_000}, async () => {
    const approved = createHash('sha256').update(benign).digest('hex');
    const mismatch = createHash('sha256').update(looping).digest('hex');
    assert.notEqual(approved, mismatch);
    const result = await runIsolatedCoreGuest(benign,
      {timeoutMs: 5000, expectedSha256: approved});
    assert.equal(result.value, 42n);
    assert.equal(result.admission.sha256, approved);
    await assert.rejects(runIsolatedCoreGuest(benign,
      {timeoutMs: 1000, expectedSha256: mismatch}), /SHA-256 mismatch/);
  });
