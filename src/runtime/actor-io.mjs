import {types} from "node:util";
import {snapshotGuestBytes} from "../snapshot-guest-bytes.mjs";

const utf8 = new TextEncoder();
// Read the internal typed-array slot rather than an overridable .byteLength
// property. Genuine cross-realm Uint8Array and Buffer views remain supported.
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const intrinsicByteLength = Function.prototype.call.bind(
  Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength").get);

class BoundedQueue {
  #items = [];
  #bytes = 0;
  constructor(maxRecords, maxBytes, sizeOf, clone) {
    if (!Number.isInteger(maxRecords) || maxRecords <= 0) throw new RangeError("maxRecords");
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new RangeError("maxBytes");
    this.maxRecords = maxRecords;
    this.maxBytes = maxBytes;
    this.sizeOf = sizeOf;
    this.clone = clone;
  }
  tryPush(value) {
    const bytes = this.sizeOf(value);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.maxBytes) return false;
    if (this.#items.length >= this.maxRecords || this.#bytes > this.maxBytes - bytes) return false;
    const owned = this.clone(value);
    // Charge exactly the bytes retained by the queue, not a caller-supplied
    // getter's estimate. A resized/detached view must fail closed.
    const ownedBytes = this.sizeOf(owned);
    if (ownedBytes !== bytes) {
      throw new TypeError("actor I/O record size changed during snapshot");
    }
    this.#items.push({owned, bytes: ownedBytes});
    this.#bytes += ownedBytes;
    return true;
  }
  shift() {
    const item = this.#items.shift();
    if (!item) return undefined;
    this.#bytes -= item.bytes;
    return item.owned;
  }
  clear() {
    this.#items.length = 0;
    this.#bytes = 0;
  }
  get length() { return this.#items.length; }
  get bytes() { return this.#bytes; }
}

const byteLength = value => {
  if (!types.isUint8Array(value))
    throw new TypeError("actor I/O bytes require a genuine Uint8Array");
  return intrinsicByteLength(value);
};
const cloneBytes = value =>
  // Snapshot via intrinsic slots, never Symbol.iterator/species/getters.
  // SharedArrayBuffer-backed views are denied, not copied under a race.
  snapshotGuestBytes(value, ActorIoEnvelope.MAX_BYTES);
const textBytes = value => utf8.encode(value).byteLength;

export class ActorIoEnvelope {
  static MAX_RECORDS = 1024;
  static MAX_BYTES = 4 * 1024 * 1024;
  static MAX_METADATA_ENTRIES = 64;
  static MAX_METADATA_BYTES = 8 * 1024;

  #actorId;
  #generation;
  #authority;
  #input;
  #output;
  #errors;
  #events;
  #metadataVersion = 1;
  #metadata = Object.freeze(Object.create(null));

  constructor({actorId, generation = 1, maxRecords = ActorIoEnvelope.MAX_RECORDS,
               maxBytes = ActorIoEnvelope.MAX_BYTES} = {}) {
    if (!Number.isSafeInteger(actorId) || actorId <= 0) throw new RangeError("actorId");
    if (!Number.isSafeInteger(generation) || generation <= 0) throw new RangeError("generation");
    this.#actorId = actorId;
    this.#generation = generation;
    this.#input = new BoundedQueue(maxRecords, maxBytes, byteLength, cloneBytes);
    this.#output = new BoundedQueue(maxRecords, maxBytes, byteLength, cloneBytes);
    this.#errors = new BoundedQueue(
      maxRecords, maxBytes,
      value => textBytes(value.code) + textBytes(value.message),
      value => Object.freeze({code: String(value.code), message: String(value.message)}));
    this.#events = new BoundedQueue(
      maxRecords, maxBytes,
      value => textBytes(value.kind) + textBytes(value.payload),
      value => Object.freeze({kind: String(value.kind), payload: String(value.payload)}));
    this.#authority = this.#mintAuthority();
  }

  #mintAuthority() {
    return Object.freeze({actorId: this.#actorId, generation: this.#generation});
  }
  #require(authority) {
    if (authority !== this.#authority) {
      throw new Error("actor I/O authority is stale, foreign, or retired");
    }
  }

  authority() { return this.#authority; }

  restart(nextGeneration) {
    if (!Number.isSafeInteger(nextGeneration) || nextGeneration <= this.#generation) {
      throw new RangeError("actor I/O generation must increase");
    }
    this.#generation = nextGeneration;
    this.#input.clear();
    this.#output.clear();
    this.#errors.clear();
    this.#events.clear();
    this.#metadataVersion = 1;
    this.#metadata = Object.freeze(Object.create(null));
    this.#authority = this.#mintAuthority();
    return this.#authority;
  }

  tryFeedInput(authority, bytes) {
    this.#require(authority);
    return this.#input.tryPush(bytes);
  }
  readInput(authority) {
    this.#require(authority);
    return this.#input.shift();
  }
  tryWriteOutput(authority, bytes) {
    this.#require(authority);
    return this.#output.tryPush(bytes);
  }
  readOutput(authority) {
    this.#require(authority);
    return this.#output.shift();
  }
  tryEmitError(authority, diagnostic) {
    this.#require(authority);
    if (!diagnostic || typeof diagnostic.code !== "string" || typeof diagnostic.message !== "string") {
      throw new TypeError("actor I/O diagnostic requires string code/message");
    }
    return this.#errors.tryPush(diagnostic);
  }
  readError(authority) {
    this.#require(authority);
    return this.#errors.shift();
  }
  tryEmitEvent(authority, event) {
    this.#require(authority);
    if (!event || typeof event.kind !== "string" || typeof event.payload !== "string") {
      throw new TypeError("actor I/O event requires string kind/payload");
    }
    return this.#events.tryPush(event);
  }
  readEvent(authority) {
    this.#require(authority);
    return this.#events.shift();
  }
  metadata(authority) {
    this.#require(authority);
    return Object.freeze({version: this.#metadataVersion, values: this.#metadata});
  }
  replaceMetadata(authority, values) {
    this.#require(authority);
    if (!values || Object.getPrototypeOf(values) !== Object.prototype) {
      throw new TypeError("actor metadata requires a plain object");
    }
    const entries = Object.entries(values);
    if (entries.length > ActorIoEnvelope.MAX_METADATA_ENTRIES) {
      throw new RangeError("actor metadata entry limit exceeded");
    }
    let bytes = 0;
    const owned = Object.create(null);
    for (const [key, value] of entries) {
      if (key.length === 0 || typeof value !== "string") {
        throw new TypeError("actor metadata requires nonempty string keys and string values");
      }
      bytes += textBytes(key) + textBytes(value);
      if (bytes > ActorIoEnvelope.MAX_METADATA_BYTES) {
        throw new RangeError("actor metadata byte limit exceeded");
      }
      owned[key] = value;
    }
    if (this.#metadataVersion >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError("actor metadata version exhausted");
    }
    this.#metadataVersion++;
    this.#metadata = Object.freeze(owned);
    return this.metadata(authority);
  }
}
