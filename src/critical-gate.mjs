/**
 * Host-side logical ticket admission for future Wasm critical {} integration.
 * This is NOT a guest-visible Wasm ABI or a replacement for the real compiler.
 * No guest continuation or callback runs during admission, handoff or retire.
 *
 * The JS host event loop serializes bookkeeping, but execution requires a
 * separate trusted scheduler with actor-generation and tenant authorization.
 */
const tickets = new WeakMap();
const MAX_WAITERS = 8192;

export class CriticalGate {
  static MAX_WAITERS = MAX_WAITERS;
  #owner = null;
  #waiting = [];
  #issued = 0;
  #retired = false;

  #ticket() {
    if (this.#issued >= Number.MAX_SAFE_INTEGER)
      throw Error("critical ticket sequence exhausted");
    this.#issued++;
    const token = Object.freeze(Object.create(null));
    tickets.set(token, {gate: this, sequence: this.#issued});
    return token;
  }

  // Synchronous attempt: no Promise, no queue, no waiting on a guest body.
  tryRequest() {
    if (this.#retired || this.#owner !== null || this.#waiting.length !== 0)
      return null;
    this.#owner = this.#ticket();
    return this.#owner;
  }

  request() {
    if (this.#retired) throw Error("critical gate retired");
    const immediate = this.#owner === null && this.#waiting.length === 0;
    if (!immediate && this.#waiting.length >= MAX_WAITERS)
      throw Error("critical waiter limit exceeded");
    const token = this.#ticket();
    if (immediate) {
      this.#owner = token;
      return Object.freeze({ticket: token, admission: "ACQUIRED"});
    }
    this.#waiting.push(token);
    return Object.freeze({ticket: token, admission: "QUEUED"});
  }

  // The caller must schedule a returned token only after generation checks.
  release(token) {
    const identity = token != null && (typeof token === "object" ||
      typeof token === "function") ? tickets.get(token) : undefined;
    if (!identity || identity.gate !== this || identity.sequence > this.#issued)
      throw Error("foreign or invalid critical ticket");
    if (this.#retired) return null;
    if (this.#owner === token) {
      this.#owner = this.#waiting.shift() ?? null;
      return this.#owner;
    }
    const at = this.#waiting.indexOf(token);
    if (at !== -1) this.#waiting.splice(at, 1);
    return null;
  }

  holds(token) {
    return !this.#retired && this.#owner === token &&
      tickets.get(token)?.gate === this;
  }

  get waiting() { return this.#waiting.length; }
  get retired() { return this.#retired; }

  // Only after the physical guest body is quiescent: this is not rollback.
  retire() {
    this.#retired = true;
    this.#owner = null;
    this.#waiting.length = 0;
  }
}
