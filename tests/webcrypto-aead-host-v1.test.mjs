import test from "node:test";
import assert from "node:assert/strict";
import { WebCryptoAeadHostV1 } from "../src/runtime/webcrypto-aead-host-v1.mjs";

test("AES-256-GCM roundtrip, tamper, nonces and close", async () => {
  const host = new WebCryptoAeadHostV1(() => true);
  const key = await host.generateKey(1);
  const other = await host.generateKey(1);
  const seen = new Set();
  const aad = Uint8Array.of(1, 2);
  const message = Uint8Array.of(65, 66, 67);
  for (let i = 0; i < 128; ++i) {
    const sealed = await key.seal(aad, message);
    assert.equal(sealed.nonce.length, 12);
    assert.equal(sealed.ciphertextAndTag.length, message.length + 16);
    const hex = Buffer.from(sealed.nonce).toString("hex");
    assert.equal(seen.has(hex), false);
    seen.add(hex);
    const recovered = await key.open(
      sealed.nonce, aad, sealed.ciphertextAndTag);
    assert.equal(recovered.ok, true);
    assert.deepEqual([...recovered.plaintext], [...message]);
    const tampered = new Uint8Array(sealed.ciphertextAndTag);
    tampered[0] ^= 1;
    assert.deepEqual(await key.open(sealed.nonce, aad, tampered),
      { ok: false, error: "authentication failed" });
    assert.deepEqual(await key.open(sealed.nonce, Uint8Array.of(9),
      sealed.ciphertextAndTag),
      { ok: false, error: "authentication failed" });
    assert.deepEqual(await other.open(sealed.nonce, aad,
      sealed.ciphertextAndTag),
      { ok: false, error: "authentication failed" });
  }
  const empty = await key.seal(new Uint8Array(), new Uint8Array());
  assert.equal(empty.ciphertextAndTag.length, 16);
  assert.equal((await key.open(empty.nonce, new Uint8Array(),
    empty.ciphertextAndTag)).ok, true);
  key.close();
  await assert.rejects(() => key.seal(aad, message), /key closed/);
  await assert.rejects(() => key.open(empty.nonce, aad,
    empty.ciphertextAndTag), /key closed/);
  other.close();
});

test("fail closed if crypto capability denied", async () => {
  const denied = new WebCryptoAeadHostV1(() => false);
  await assert.rejects(() => denied.generateKey(1), /capability denied/);
  const host = new WebCryptoAeadHostV1(() => true);
  await assert.rejects(() => host.generateKey(2), /unsupported AEAD/);
  const key = await host.generateKey(1);
  key.close();
  assert.throws(() => new WebCryptoAeadHostV1(), /authority/);
});
