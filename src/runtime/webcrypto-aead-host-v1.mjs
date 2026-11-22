// Native WebCrypto-backed authenticated encryption, host-only.
// Not a guest import or capability grant: the trusted caller must supply the
// non-forgeable authority check and keep Key handles out of guest JS objects.
// AES-256-GCM only; ChaCha20-Poly1305 must fail closed until vetted support.
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_AAD_BYTES = 64 * 1024;
const MAX_ENCRYPTIONS = 1n << 32n;
const INTERNAL_KEY_CONSTRUCTOR = Symbol("trusted AEAD key constructor");

function provider() {
  const crypto = globalThis.crypto;
  if (!crypto?.subtle || typeof crypto.getRandomValues !== "function") {
    throw new Error("trusted WebCrypto provider unavailable");
  }
  return crypto;
}

function checkedBytes(input, minimum, maximum, label) {
  if (!(input instanceof Uint8Array) ||
      input.byteLength < minimum || input.byteLength > maximum) {
    throw new TypeError(`invalid ${label} length`);
  }
  // Snapshot before the first async suspension, including view offsets.
  return new Uint8Array(input);
}

export class WebCryptoAeadHostV1 {
  #authorize;
  constructor(authorize) {
    if (typeof authorize !== "function") {
      throw new TypeError("trusted crypto authority callback required");
    }
    this.#authorize = authorize;
  }

  authorize(operation) {
    // Only the trusted runtime supplies this callback and actor ownership.
    // A boolean return value is required; absence/undefined is deny.
    if (this.#authorize(operation) !== true) {
      throw new Error("crypto capability denied");
    }
  }

  async generateKey(algorithm = 1) {
    this.authorize("aead_new_key");
    if (algorithm !== 1) {
      throw new Error("unsupported AEAD algorithm: no unaudited fallback");
    }
    const crypto = provider();
    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const prefix = new Uint8Array(4);
    crypto.getRandomValues(prefix);
    this.authorize("aead_new_key");
    return new WebCryptoAeadKeyV1(this, key, prefix, INTERNAL_KEY_CONSTRUCTOR);
  }
}

export class WebCryptoAeadKeyV1 {
  #owner;
  #key;
  #prefix;
  #next = 0n;
  #closed = false;

  constructor(owner, key, prefix, constructorProof) {
    if (constructorProof !== INTERNAL_KEY_CONSTRUCTOR ||
        !(owner instanceof WebCryptoAeadHostV1) ||
        !(key instanceof CryptoKey) || key.extractable ||
        !(prefix instanceof Uint8Array) || prefix.byteLength !== 4) {
      throw new TypeError("invalid trusted crypto key construction");
    }
    this.#owner = owner;
    this.#key = key;
    this.#prefix = new Uint8Array(prefix);
  }

  #requireLive(operation) {
    this.#owner.authorize(operation);
    if (this.#closed || this.#key === null) {
      throw new Error("AEAD key closed");
    }
  }

  #reserveNonce() {
    if (this.#next >= MAX_ENCRYPTIONS) {
      throw new Error("AEAD key encryption quota exhausted");
    }
    let counter = this.#next++;
    const nonce = new Uint8Array(12);
    nonce.set(this.#prefix, 0);
    for (let i = 11; i >= 4; --i) {
      nonce[i] = Number(counter & 255n);
      counter >>= 8n;
    }
    return nonce;
  }

  async seal(aad, plaintext) {
    this.#requireLive("aead_seal");
    const a = checkedBytes(aad, 0, MAX_AAD_BYTES, "AAD");
    const p = checkedBytes(plaintext, 0, MAX_MESSAGE_BYTES, "plaintext");
    const nonce = this.#reserveNonce();
    const key = this.#key;
    try {
      const output = await provider().subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData: a, tagLength: 128 },
        key, p);
      this.#requireLive("aead_seal");
      return { nonce, ciphertextAndTag: new Uint8Array(output) };
    } finally {
      a.fill(0);
      p.fill(0);
    }
  }

  async open(nonce, aad, ciphertextAndTag) {
    this.#requireLive("aead_open");
    // Return one error for malformed payloads and all auth failures.
    if (!(nonce instanceof Uint8Array) || nonce.length !== 12 ||
        !(aad instanceof Uint8Array) || aad.length > MAX_AAD_BYTES ||
        !(ciphertextAndTag instanceof Uint8Array) ||
        ciphertextAndTag.length < 16 ||
        ciphertextAndTag.length > MAX_MESSAGE_BYTES + 16) {
      return { ok: false, error: "authentication failed" };
    }
    const n = new Uint8Array(nonce);
    const a = new Uint8Array(aad);
    const input = new Uint8Array(ciphertextAndTag);
    try {
      const output = await provider().subtle.decrypt(
        { name: "AES-GCM", iv: n, additionalData: a, tagLength: 128 },
        this.#key, input);
      this.#requireLive("aead_open");
      return { ok: true, plaintext: new Uint8Array(output) };
    } catch (error) {
      if (this.#closed) throw new Error("AEAD key closed");
      // Expected auth failure must not reveal algorithm/provider exceptions.
      if (error?.name !== "OperationError") throw error;
      return { ok: false, error: "authentication failed" };
    } finally {
      n.fill(0);
      a.fill(0);
      input.fill(0);
    }
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#prefix.fill(0);
    this.#key = null;
    // The non-extractable CryptoKey is revoked from this host wrapper. The
    // browser/engine owns actual key-memory erasure and GC; not guaranteed.
  }
}
