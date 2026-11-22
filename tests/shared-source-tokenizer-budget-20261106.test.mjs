import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rejectUnsupportedDurableM0Source,
  rejectUnsupportedStateContainerVirtualActorSource,
  rejectUnsupportedTupleV2Source,
  rejectUnsupportedInvertedLayoutSource,
  rejectUnsupportedHeapContainerSource,
  rejectUnsupportedStructuralPatternSource
} from '../scripts/compile-ores.mjs';

const preflights = [
  rejectUnsupportedDurableM0Source,
  rejectUnsupportedStateContainerVirtualActorSource,
  rejectUnsupportedTupleV2Source,
  rejectUnsupportedInvertedLayoutSource,
  rejectUnsupportedHeapContainerSource,
  rejectUnsupportedStructuralPatternSource
];

test('all direct shared preflights deny oversized input before decode', () => {
  const oversized = new Uint8Array(1_048_577);
  for (const scan of preflights)
    assert.throws(() => scan(oversized), /source preflight byte budget exceeded/);
});

test('punctuation-heavy source cannot create an unbounded token ledger', () => {
  const manyTokens = new TextEncoder().encode('.'.repeat(100_001));
  for (const scan of [rejectUnsupportedDurableM0Source,
                       rejectUnsupportedHeapContainerSource])
    assert.throws(() => scan(manyTokens), /source preflight token budget exceeded/);
});

test('normal bounded source and empty source remain accepted', () => {
  const safe = new TextEncoder().encode('pub fnc main():int{return 42;}');
  for (const scan of preflights) {
    assert.doesNotThrow(() => scan(safe));
    assert.doesNotThrow(() => scan(new Uint8Array()));
  }
});

test('non-byte callers and malformed UTF-8 fail closed', () => {
  assert.throws(() => rejectUnsupportedDurableM0Source('define actor X as end'),
    /source preflight requires byte input/);
  assert.throws(() => rejectUnsupportedDurableM0Source(new Uint8Array([0xc0, 0xaf])),
    /encoded data was not valid|encoding/i);
});
