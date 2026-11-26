// Host-owned monotonic safe-integer identities. Exhaustion is permanent.
export class MonotonicIdentityV1 {
  #last;
  constructor(last = 0) {
    if (!Number.isSafeInteger(last) || last < 0)
      throw new RangeError('invalid identity high-water mark');
    this.#last = last;
  }
  issue() {
    if (this.#last === Number.MAX_SAFE_INTEGER) return null;
    return ++this.#last;
  }
}
