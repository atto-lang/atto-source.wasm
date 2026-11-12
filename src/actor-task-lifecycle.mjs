// Trusted Wasm carrier bookkeeping only. This does not compile or execute
// AttoLang task {}, task scope {}, suspends, or await. A future compiler
// continuation bridge must authenticate the actor physical turn before admit().
const valid_capacity = n => Number.isSafeInteger(n) && n > 0 && n <= 1024;

export class ActorTaskLedger {
  #tasks = new Map();
  #capacity;
  #stopped = false;

  constructor({capacity = 8} = {}) {
    if (!valid_capacity(capacity)) throw new RangeError('invalid actor task capacity');
    this.#capacity = capacity;
  }

  #get(token) {
    const task = this.#tasks.get(token);
    if (!task) throw Error('foreign or stale actor task token');
    return task;
  }

  // Called only from an authenticated actor DATA/TASK/WAKE carrier turn.
  // No guest code may be passed to this function.
  admit(parent = null) {
    if (this.#stopped) throw Error('actor stopped');
    if (this.#tasks.size >= this.#capacity) throw Error('actor task quota exceeded');
    if (parent !== null) {
      const p = this.#get(parent);
      if (p.cancelled || p.stage === 'done') throw Error('parent task unavailable');
    }
    const token = Object.freeze(Object.create(null));
    this.#tasks.set(token, {parent, stage: 'ready', cancelled: false});
    return token;
  }

  startOrResume(token) {
    const task = this.#get(token);
    if (this.#stopped || task.cancelled) throw Error('actor task cancelled or stopped');
    // One mutable actor turn at a time, even with multiple logical tasks.
    for (const [other, running] of this.#tasks)
      if (other !== token && running.stage === 'running') throw Error('actor turn busy');
    if (task.stage !== 'ready' && task.stage !== 'suspended')
      throw Error('invalid actor task turn transition');
    task.stage = 'running';
  }

  suspend(token) {
    const task = this.#get(token);
    if (task.stage !== 'running') throw Error('invalid actor task suspension');
    task.stage = 'suspended';
  }

  // Only after an actor guest turn physically returned.
  completeTurn(token) {
    const task = this.#get(token);
    if (task.stage !== 'running') throw Error('task is not executing');
    task.stage = 'done';
  }

  #descendsFrom(token, root) {
    for (let current = token; current !== null;) {
      if (current === root) return true;
      current = this.#get(current).parent;
    }
    return false;
  }

  // A settled parent result can still cancel live children. Cancellation does
  // not imply quiescence or release of any actor-owned continuation frame.
  requestCancel(token) {
    this.#get(token);
    for (const [candidate, task] of this.#tasks)
      if (this.#descendsFrom(candidate, token)) task.cancelled = true;
  }

  stop() {
    this.#stopped = true;
    for (const task of this.#tasks.values()) task.cancelled = true;
  }

  // Must run as trusted cleanup. An executing turn must finish physically.
  cleanupCancelled(token) {
    const task = this.#get(token);
    if (!task.cancelled || (task.stage !== 'ready' && task.stage !== 'suspended'))
      throw Error('physical task quiescence not proven');
    task.stage = 'done';
  }

  // Runtime's explicit cleanup receipt; settlement alone never frees a slot.
  retire(token) {
    const task = this.#get(token);
    if (task.stage !== 'done') throw Error('physical task quiescence not proven');
    for (const child of this.#tasks.values())
      if (child.parent === token) throw Error('nested task not yet retired');
    this.#tasks.delete(token);
  }

  get outstanding() {return this.#tasks.size;}
  isQuiescent() {return this.#tasks.size === 0;}
  stage(token) {return this.#get(token).stage;}
  isCancellationRequested(token) {return this.#get(token).cancelled;}
}
