// Trusted host substrate only. NOT an AttoLang compiler lowering or guest API.
// Wasm workers use a coordinator for logical identity; shared object pointers do
// not exist across independent worker/isolate heaps. Never export host tokens.
const MAX_NODES = 2048;
const MAX_DEPTH = 64;
const MAX_READERS = 1024;

function checked_name(name, label) {
  if (typeof name !== 'string' || !name || name.length > 256
      || name.includes('\0') || name.includes('\\')
      || /[\u0000-\u001f\u007f]/u.test(name)
      || name !== name.normalize('NFC')
      || name.split('/').some(p => p === '..' || p === '.')) {
    throw new TypeError('invalid ' + label);
  }
  return name;
}

export function singleton_key(namespace, module, declaration) {
  return JSON.stringify([
    checked_name(namespace, 'singleton namespace'),
    checked_name(module, 'singleton module'),
    checked_name(declaration, 'singleton declaration'),
  ]);
}

function frozen_copy(value, state = {count: 0, active: new WeakSet()}, depth = 0) {
  if (++state.count > MAX_NODES || depth > MAX_DEPTH) throw new RangeError('singleton snapshot budget');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > 8192 || value !== value.normalize('NFC')) throw new TypeError('invalid singleton string');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError('invalid singleton number');
    return value;
  }
  if (typeof value !== 'object') throw new TypeError('unproved singleton value type');
  if (state.active.has(value)) throw new TypeError('cyclic singleton snapshot');
  if (Object.getOwnPropertySymbols(value).length) throw new TypeError('symbol-keyed mutable alias');
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > 1024) throw new RangeError('singleton array budget');
      const output = [];
      for (let i = 0; i < value.length; i++) {
        const desc = Object.getOwnPropertyDescriptor(value, String(i));
        if (!desc || !Object.hasOwn(desc, 'value')) throw new TypeError('sparse/accessor array');
        output.push(frozen_copy(desc.value, state, depth + 1));
      }
      for (const key of Reflect.ownKeys(value)) {
        if (key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key)
            || Number(key) >= value.length)) throw new TypeError('array extra property');
      }
      return Object.freeze(output);
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype) throw new TypeError('nonplain singleton object');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).sort();
    if (keys.length > 1024) throw new RangeError('singleton object budget');
    const out = Object.create(null);
    for (const key of keys) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype'
          || key.length > 256 || key !== key.normalize('NFC')) throw new TypeError('unsafe singleton key');
      const desc = descriptors[key];
      if (!Object.hasOwn(desc, 'value') || !desc.enumerable) throw new TypeError('accessor/hidden singleton field');
      out[key] = frozen_copy(desc.value, state, depth + 1);
    }
    return Object.freeze(out);
  } finally {
    state.active.delete(value);
  }
}

class Region {
  #host;
  #owner;
  #epoch = 1;
  #closed = false;
  #snapshot;
  #queue = [];
  #reserved = new Set();
  #active = new Map();
  #readers = 0;
  #writer = null;
  #callback_pins = 0;
  #budget;
  #grants = new WeakMap();

  constructor(host, owner, initial, max_pending) {
    this.#host = host;
    this.#owner = owner;
    this.#snapshot = frozen_copy(initial);
    if (!Number.isInteger(max_pending) || max_pending < 0 || max_pending > 4096)
      throw new RangeError('singleton pending quota');
    this.#budget = max_pending;
  }

  get reader_count() { return this.#readers; }
  get writer_count() { return this.#writer === null ? 0 : 1; }
  get pending_count() { return this.#queue.length; }
  get physically_retired() {
    return this.#closed && this.#reserved.size === 0 && this.#active.size === 0
      && this.#queue.length === 0 && this.#callback_pins === 0;
  }

  grant(owner, borrower, mode) {
    this.#host.assert_principal(borrower);
    if (owner !== this.#owner || this.#closed) throw new Error('only singleton owner may delegate');
    if (mode !== 'read' && mode !== 'write') throw new TypeError('invalid singleton grant mode');
    const token = Object.freeze(Object.create(null));
    this.#grants.set(token, {borrower, mode, epoch: this.#epoch, used: false});
    return token;
  }

  acquire(borrower, grant, {signal} = {}) {
    const g = grant && this.#grants.get(grant);
    if (!this.#host.is_principal(borrower) || this.#closed || !g
        || g.borrower !== borrower || g.epoch !== this.#epoch || g.used) {
      return Promise.reject(new Error('stale or forged singleton grant'));
    }
    if (this.#reserved.has(borrower)) return Promise.reject(new Error('recursive singleton loan'));
    if (signal?.aborted) return Promise.reject(new Error('singleton admission cancelled'));
    if (this.#queue.length >= this.#budget && !this.#can_admit_now(g.mode))
      return Promise.reject(new Error('singleton admission queue full'));
    g.used = true;
    this.#reserved.add(borrower);
    return new Promise((resolve, reject) => {
      const req = {borrower, mode: g.mode, resolve, reject, signal, on_abort: null};
      if (signal) {
        req.on_abort = () => {
          const index = this.#queue.indexOf(req);
          if (index < 0) return;
          this.#queue.splice(index, 1);
          this.#reserved.delete(borrower);
          this.#unbind(req);
          reject(new Error('singleton admission cancelled'));
          this.#pump();
        };
        signal.addEventListener('abort', req.on_abort, {once: true});
      }
      this.#queue.push(req);
      this.#pump();
    });
  }

  #can_admit_now(mode) {
    return this.#queue.length === 0 && this.#callback_pins === 0 && !this.#writer
      && (mode === 'read' ? this.#readers < MAX_READERS : this.#readers === 0);
  }

  #unbind(req) {
    if (req.signal && req.on_abort) req.signal.removeEventListener('abort', req.on_abort);
  }

  #pump() {
    if (this.#closed || this.#writer || this.#callback_pins) return;
    while (this.#queue.length) {
      const req = this.#queue[0];
      if (req.mode === 'write' ? this.#readers !== 0 : this.#readers >= MAX_READERS) return;
      this.#queue.shift();
      this.#unbind(req);
      const lease = Object.freeze({
        read: caller => this.#read(caller, lease),
        write: (caller, update) => this.#write(caller, lease, update),
        release: caller => this.#release(caller, lease),
      });
      this.#active.set(req.borrower, {lease, mode: req.mode, generation: this.#epoch});
      if (req.mode === 'read') this.#readers++;
      else this.#writer = lease;
      req.resolve(lease);
      if (req.mode === 'write') return;
    }
  }

  #check(caller, lease) {
    const x = this.#active.get(caller);
    if (!this.#host.is_principal(caller) || !x || x.lease !== lease
        || x.generation !== this.#epoch || this.#closed) {
      throw new Error('revoked singleton loan');
    }
    return x;
  }

  #read(caller, lease) {
    this.#check(caller, lease);
    return this.#snapshot;
  }

  #write(caller, lease, update) {
    const x = this.#check(caller, lease);
    if (x.mode !== 'write' || this.#writer !== lease) throw new Error('exclusive singleton write required');
    if (typeof update !== 'function' || this.#callback_pins !== 0)
      throw new TypeError('recursive singleton write callback');
    this.#callback_pins++;
    try {
      const candidate = update(this.#snapshot);
      if (candidate && typeof candidate.then === 'function') {
        throw new Error('await/suspension under singleton write forbidden');
      }
      const frozen = frozen_copy(candidate);
      this.#check(caller, lease);
      if (this.#writer !== lease) throw new Error('revoked singleton writer');
      this.#snapshot = frozen;
      return frozen;
    } finally {
      this.#callback_pins--;
      this.#pump();
    }
  }

  #release(caller, lease) {
    const x = this.#active.get(caller);
    if (!this.#host.is_principal(caller) || !x || x.lease !== lease)
      throw new Error('foreign or released singleton loan');
    this.#active.delete(caller);
    this.#reserved.delete(caller);
    if (x.mode === 'read') this.#readers--;
    else {
      if (this.#writer !== lease) throw new Error('singleton writer ledger corrupted');
      this.#writer = null;
    }
    this.#pump();
  }

  transfer_owner(old_owner, new_owner) {
    this.#host.assert_principal(new_owner);
    if (this.#closed || old_owner !== this.#owner || this.#active.size || this.#queue.length
        || this.#callback_pins || this.#reserved.size) throw new Error('singleton transfer requires quiescence');
    if (this.#epoch >= Number.MAX_SAFE_INTEGER) throw new Error('singleton epoch exhausted');
    this.#owner = new_owner;
    this.#epoch++;
  }

  stop(owner) {
    if (owner !== this.#owner) throw new Error('foreign singleton STOP');
    if (this.#closed) return;
    if (this.#epoch >= Number.MAX_SAFE_INTEGER) throw new Error('singleton epoch exhausted');
    this.#closed = true;
    this.#epoch++;
    for (const q of this.#queue.splice(0)) {
      this.#reserved.delete(q.borrower);
      this.#unbind(q);
      q.reject(new Error('singleton region STOP'));
    }
  }
}

/**
 * Host coordinator only; never inject this object into guest WebAssembly or
 * worker execution scopes. Send immutable snapshots and nominal Symbol keys
 * by structured clone/message passing instead of transferring JavaScript refs.
 */
export class SingletonDomainHostV1 {
  #consts = new Map();
  #regions = new Map();
  #principals = new WeakSet();
  #turns = new Map();
  #symbols = new Map();
  #symbol_bytes = 0;
  #quota;

  constructor({max_singletons = 4096, max_symbols = 4096} = {}) {
    if (!Number.isSafeInteger(max_singletons) || max_singletons < 1 || max_singletons > 65536
        || !Number.isSafeInteger(max_symbols) || max_symbols < 1 || max_symbols > 65536)
      throw new RangeError('singleton domain quotas');
    this.#quota = {max_singletons, max_symbols};
  }

  mint_actor_turn(actor_id, incarnation, execution_id) {
    for (const x of [actor_id, incarnation, execution_id]) {
      if (!Number.isSafeInteger(x) || x < 0) throw new TypeError('invalid actor execution identity');
    }
    if (incarnation === 0) throw new TypeError('missing actor incarnation');
    const key = JSON.stringify([actor_id, incarnation, execution_id]);
    let p = this.#turns.get(key);
    if (!p) {
      p = Object.freeze(Object.create(null));
      this.#principals.add(p);
      this.#turns.set(key, p);
    }
    return p;
  }

  is_principal(p) { return p !== null && typeof p === 'object' && this.#principals.has(p); }
  assert_principal(p) {
    if (!this.is_principal(p)) throw new Error('foreign or forged singleton principal');
  }

  publish_const(namespace, module, declaration, initial) {
    const key = singleton_key(namespace, module, declaration);
    const frozen = frozen_copy(initial);
    const fingerprint = JSON.stringify(frozen);
    const current = this.#consts.get(key);
    if (current) {
      if (current.fingerprint !== fingerprint) throw new Error('singleton schema mismatch');
      return current.snapshot;
    }
    if (this.#consts.size >= this.#quota.max_singletons) throw new RangeError('singleton identity quota');
    this.#consts.set(key, {fingerprint, snapshot: frozen});
    return frozen;
  }

  region(namespace, module, declaration, owner, initial, max_pending = 128) {
    this.assert_principal(owner);
    const key = singleton_key(namespace, module, declaration);
    const old = this.#regions.get(key);
    if (old) return old;
    if (this.#regions.size >= this.#quota.max_singletons) throw new RangeError('shared region quota');
    const value = new Region(this, owner, initial, max_pending);
    this.#regions.set(key, value);
    return value;
  }

  intern_symbol(name, {scope = 'process'} = {}) {
    if (scope !== 'core' && scope !== 'process' && scope !== 'private') {
      throw new TypeError('unknown symbol scope');
    }
    const normalized = checked_name(name, 'symbol name');
    const key = JSON.stringify([scope, normalized]);
    const existing = this.#symbols.get(key);
    if (existing) return existing;
    const bytes = new TextEncoder().encode(normalized).length;
    if (this.#symbols.size >= this.#quota.max_symbols || this.#symbol_bytes + bytes > 1048576)
      throw new RangeError('symbol interning quota');
    const symbol = Object.freeze({tag: 'ores.symbol.v1', scope, name: normalized});
    this.#symbols.set(key, symbol);
    this.#symbol_bytes += bytes;
    return symbol;
  }

  resolve_symbol(payload, {trusted = false} = {}) {
    if (!payload || typeof payload !== 'object'
        || Object.keys(payload).sort().join(',') !== 'name,scope,tag'
        || payload.tag !== 'ores.symbol.v1') throw new TypeError('invalid nominal symbol');
    if (payload.scope === 'private' && !trusted) throw new Error('private symbol transport forbidden');
    const name = checked_name(payload.name, 'symbol name');
    const key = JSON.stringify([payload.scope, name]);
    const known = this.#symbols.get(key);
    if (!known) throw new Error('unknown symbol cannot intern via untrusted decode');
    return known;
  }
}
