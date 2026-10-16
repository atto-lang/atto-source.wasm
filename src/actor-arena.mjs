// Host-only experimental actor-owned region. NOT attached to a guest module.
// Every SHARED actor retains a private arena; ActorRef never grants heap access.
// Guest source arena lowering and shared-domain regions are separate gates.
const PAGE = 65536;
const kinds = new Set(["shared", "private", "untrusted"]);

export class ActorArena {
  #memory;
  #actor;
  #incarnation;
  #turn = null;
  #handles = new WeakMap();
  #scratch = new WeakMap();
  #persistentTop = 0;
  #scratchTop = 0;
  #closed = false;

  constructor({actorId, incarnation, kind = "shared"} = {}) {
    if (!Number.isSafeInteger(actorId) || actorId <= 0 ||
        !Number.isSafeInteger(incarnation) || incarnation <= 0 ||
        !kinds.has(kind)) throw new TypeError("invalid actor arena owner");
    this.#actor = actorId;
    this.#incarnation = incarnation;
    // Fixed, bounded linear memory; one 64-KiB persistent and one scratch page.
    // Never exported to guest code. JS GC still controls physical release.
    this.#memory = new WebAssembly.Memory({initial: 2, maximum: 2});
  }

  get actorId() { return this.#actor; }
  get incarnation() { return this.#incarnation; }
  get retired() { return this.#closed; }

  #bytes() {
    if (this.#closed) throw new Error("actor arena retired");
    return new Uint8Array(this.#memory.buffer);
  }

  #requireTurn(token) {
    this.#bytes();
    if (token === null || token !== this.#turn) {
      throw new Error("actor turn authority required");
    }
  }

  beginTurn() {
    this.#bytes();
    if (this.#turn !== null) throw new Error("actor already admitted");
    const turn = Object.freeze({});
    this.#turn = turn;
    return turn;
  }

  endTurn(turn) {
    this.#requireTurn(turn);
    this.#bytes().fill(0, PAGE, PAGE + this.#scratchTop);
    this.#scratchTop = 0;
    this.#scratch = new WeakMap();
    this.#turn = null;
  }

  #alloc(turn, length, scratch) {
    this.#requireTurn(turn);
    if (!Number.isSafeInteger(length) || length <= 0 || length > PAGE) {
      throw new RangeError("invalid arena allocation length");
    }
    const top = scratch ? this.#scratchTop : this.#persistentTop;
    if (length > PAGE - top) throw new RangeError("actor arena quota exhausted");
    const handle = Object.freeze({});
    const slot = {offset: (scratch ? PAGE : 0) + top, length};
    (scratch ? this.#scratch : this.#handles).set(handle, slot);
    if (scratch) this.#scratchTop += length;
    else this.#persistentTop += length;
    return handle;
  }

  allocPersistent(turn, length) { return this.#alloc(turn, length, false); }
  allocScratch(turn, length) { return this.#alloc(turn, length, true); }

  #slot(turn, handle) {
    this.#requireTurn(turn);
    const entry = this.#handles.get(handle) ?? this.#scratch.get(handle);
    if (!entry) throw new Error("foreign or stale arena handle");
    return entry;
  }

  read(turn, handle) {
    const {offset, length} = this.#slot(turn, handle);
    return this.#bytes().slice(offset, offset + length); // owned copy
  }

  write(turn, handle, data) {
    const {offset, length} = this.#slot(turn, handle);
    if (!(data instanceof Uint8Array) || data.byteLength !== length) {
      throw new TypeError("arena write requires exact-size Uint8Array");
    }
    // Never return live memory views; callers cannot retain a raw alias.
    this.#bytes().set(data, offset);
  }

  retire() {
    if (this.#closed) return;
    if (this.#turn !== null) throw new Error("active actor turn blocks retirement");
    this.#bytes().fill(0);
    this.#closed = true;
    this.#memory = null; // physical release is JS runtime-dependent
    this.#handles = new WeakMap();
    this.#scratch = new WeakMap();
  }
}
