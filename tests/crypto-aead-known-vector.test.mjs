import test from "node:test";
import assert from "node:assert/strict";

// NIST SP 800-38D AES-256-GCM fixed-key KAT. Testing the host WebCrypto
// provider directly does NOT make raw key import available to guest code.
// The production WebCryptoAeadHostV1 only creates non-extractable random keys.
test("AES-256-GCM known answer with empty plaintext and 96-bit zero IV", async () => {
  const crypto = globalThis.crypto;
  assert.ok(crypto?.subtle, "WebCrypto is required; no false PASS on skip");
  const key = await crypto.subtle.importKey(
    "raw", new Uint8Array(32),
    { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  const nonce = new Uint8Array(12);
  const ciphertextAndTag = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: new Uint8Array(),
      tagLength: 128 }, key, new Uint8Array()));
  assert.equal(Buffer.from(ciphertextAndTag).toString("hex"),
    "530f8afbc74536b9a963b4f1c4cb738b");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce, tagLength: 128 }, key, ciphertextAndTag);
  assert.equal(plaintext.byteLength, 0);
});
