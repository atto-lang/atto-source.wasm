/**
 * Host-side cooperation accounting, NOT a compiler-inserted guest safepoint.
 * The compiler must commit bounded work and call the slow path ONLY at
 * periodic boundaries. It must prove that no dynamic operation can hide
 * unbounded work inside a charge (nested loops, recursion or foreign calls).
 * This helper cannot preempt a synchronous JS/Wasm guest.
 */
export class BatchedCooperationMeter {
  #phase = 0;
  #completed = 0;
  #servicingCheckpoint = false;
  #interval;
  static get DISPATCH_BUDGET() { return 512; }

  constructor(interval = 128) {
    if (interval !== 128 && interval !== 512)
      throw new RangeError('cooperation interval must be 128 or 512');
    this.#interval = interval;
  }

  get completed() { return this.#completed; }
  get phase() { return this.#phase; }
  get interval() { return this.#interval; }

  // Reset only on an actual scheduler dispatch, not on an inner loop or await.
  begin_dispatch() {
    if (this.#servicingCheckpoint)
      throw new Error('reentrant cooperation dispatch reset');
    this.#phase = 0;
    this.#completed = 0;
  }

  // work is compiler-proven committed bounded work, never a guest-controlled
  // arbitrary skip. Reject batches larger than the interval: otherwise a
  // single charge could cross multiple mandatory checkpoint boundaries.
  commit_batch(work, on_checkpoint) {
    if (this.#servicingCheckpoint)
      throw new Error('reentrant cooperation charge');
    if (!Number.isSafeInteger(work) || work < 1 || work > this.#interval)
      throw new RangeError('invalid bounded cooperation batch');
    if (typeof on_checkpoint !== 'function')
      throw new TypeError('checkpoint callback required');
    const nextPhase = this.#phase + work;
    const due = nextPhase >= this.#interval;
    this.#phase = nextPhase % this.#interval;
    // Saturate instead of wrapping: an overdue dispatch never becomes fresh.
    this.#completed = Math.min(Number.MAX_SAFE_INTEGER, this.#completed + work);
    if (due) {
      // Keep the phase committed if a trusted scheduler callback throws.
      // A failed callback must not be replayed at the same boundary.
      this.#servicingCheckpoint = true;
      try {
        const outcome = on_checkpoint(Object.freeze({
          completed: this.#completed,
          overdue: this.#completed >= BatchedCooperationMeter.DISPATCH_BUDGET
        }));
        // Ignoring an asynchronous scheduler result could let guest code
        // continue after an apparent yield. No thenable property is read;
        // opaque callback results are rejected without running getters.
        if (outcome !== null &&
            (typeof outcome === 'object' || typeof outcome === 'function'))
          throw new TypeError('asynchronous checkpoint callback unsupported');
      } finally {
        this.#servicingCheckpoint = false;
      }
    }
    return due;
  }
}

// Do not permit a guest/plugin to mutate the budget advertised to observers.
Object.freeze(BatchedCooperationMeter);
