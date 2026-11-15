const utf8 = new TextEncoder();

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
    this.#items.push({owned, bytes});
    this.#bytes += bytes;
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

const cloneBytes = value => {
  if (!(value instanceof Uint8Array)) throw new TypeError("actor I/O bytes require Uint8Array");
  return Uint8Array.from(value);
};
const byteLength = value => value.byteLength;
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
  #inputClosed = false;
  #outputClosed = false;
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
    // A new actor generation gets fresh, open logical streams.
    this.#inputClosed = false;
    this.#outputClosed = false;
    this.#metadataVersion = 1;
    this.#metadata = Object.freeze(Object.create(null));
    this.#authority = this.#mintAuthority();
    return this.#authority;
  }

  tryFeedInput(authority, bytes) {
    this.#require(authority);
    return !this.#inputClosed && this.#input.tryPush(bytes);
  }
  readInput(authority) {
    this.#require(authority);
    return this.#input.shift();
  }
  // Host-only half-close; accepted records remain readable until drained.
  // Repeated close must not manufacture additional readiness signals.
  closeInput(authority) {
    this.#require(authority);
    if (this.#inputClosed) return false;
    this.#inputClosed = true;
    return true;
  }
  inputAtEof(authority) {
    this.#require(authority);
    return this.#inputClosed && this.#input.length === 0;
  }
  tryWriteOutput(authority, bytes) {
    this.#require(authority);
    return !this.#outputClosed && this.#output.tryPush(bytes);
  }
  readOutput(authority) {
    this.#require(authority);
    return this.#output.shift();
  }
  closeOutput(authority) {
    this.#require(authority);
    if (this.#outputClosed) return false;
    this.#outputClosed = true;
    return true;
  }
  outputAtEof(authority) {
    this.#require(authority);
    return this.#outputClosed && this.#output.length === 0;
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
