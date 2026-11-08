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
  #interval;
  static DISPATCH_BUDGET = 512;

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
    this.#phase = 0;
    this.#completed = 0;
  }

  // work is compiler-proven committed bounded work, never a guest-controlled
  // arbitrary skip. Reject batches larger than the interval: otherwise a
  // single charge could cross multiple mandatory checkpoint boundaries.
  commit_batch(work, on_checkpoint) {
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
      on_checkpoint({
        completed: this.#completed,
        overdue: this.#completed >= BatchedCooperationMeter.DISPATCH_BUDGET
      });
    }
    return due;
  }
}
