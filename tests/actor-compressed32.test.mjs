import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_COMPRESSED32_OFFSET, MAX_COMPRESSED32_SPAN,
  encodeCompressed32, decodeCompressed32,
  decodeStoredCompressed32, dereferenceCompressed32
} from "../src/actor-compressed32.mjs";

test("compressed32 reserves null and treats high-bit words as unsigned", () => {
  assert.equal(MAX_COMPRESSED32_OFFSET,34359738352n);
  assert.equal(MAX_COMPRESSED32_SPAN,34359738360n);
  assert.equal(encodeCompressed32(0n),1);
  assert.equal(decodeCompressed32(0),null);
  assert.equal(decodeCompressed32(1),0n);
  assert.equal(encodeCompressed32(MAX_COMPRESSED32_OFFSET),0xffff_ffff);
  assert.equal(decodeCompressed32(0xffff_ffff),MAX_COMPRESSED32_OFFSET);
  assert.equal(decodeCompressed32(0x8000_0000),0x7fff_ffffn*8n);
});

test("compressed32 rejects truncation, signed-extension and out-of-span dereference", () => {
  assert.throws(()=>encodeCompressed32(3n),/cannot be encoded/);
  assert.throws(()=>encodeCompressed32(MAX_COMPRESSED32_OFFSET+8n),/cannot be encoded/);
  assert.throws(()=>decodeStoredCompressed32(0x1_0000_0000n),/high bits/);
  assert.throws(()=>dereferenceCompressed32(0n,MAX_COMPRESSED32_SPAN,8n),/null/);
  assert.throws(()=>dereferenceCompressed32(
    0xffff_ffffn,MAX_COMPRESSED32_OFFSET,8n),/outside/);
  assert.equal(dereferenceCompressed32(1n,8n,8n),0n);
});

test("compressed32 remains a representation, not wasm address authority", () => {
  // Two actors may encode the same logical offset word. Owner/incarnation,
  // object-start issuance and liveness are deliberately outside this codec.
  const a = encodeCompressed32(0n);
  const b = encodeCompressed32(0n);
  assert.equal(a,b);
  assert.equal(a,1);
});
