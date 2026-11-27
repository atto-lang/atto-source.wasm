// Private host-side state admission for compiled, Worker-local Atto guests.
// This module deliberately does not park a JS thread or advertise shared
// memory/cohort scheduling: synchronous Wasm imports must grant immediately
// or fail closed. Multi-Worker queued continuations are a separate ABI.
//
// Tickets, container generations and logical actor/continuation identity are
// minted here by the trusted host, never received from guest source.
// Only compiler-emitted code may call state_* imports. An arbitrary malicious
// Wasm module is NOT authenticated by this host API alone.

let nextRuntimeId = 0;
const MAX_RUNTIME_ID = 0x7fffffff;
const MAX_TICKET_ID = 0xffffffff;

function fail(message) { throw new Error('E_STATE_RUNTIME: ' + message); }

/** Creates one host scheduler authority for a single Wasm guest instance. */
export function createStateRuntime({
  maxContainers = 1024, maxTickets = 1024, onEvent = null,
} = {}) {
  if (!Number.isSafeInteger(maxContainers) || maxContainers < 1 ||
      !Number.isSafeInteger(maxTickets) || maxTickets < 1) {
    fail('invalid admission capacities');
  }
  if (onEvent !== null && typeof onEvent !== 'function') fail('invalid state observer');
  if (nextRuntimeId >= MAX_RUNTIME_ID) fail('runtime identity exhausted');
  const actorIncarnation = ++nextRuntimeId;
  let nextContainerId = 0;
  let nextTicketId = 0;
  let retired = false;
  let terminalOutcome = null;
  const containers = new Map(); // private pointer -> host-owned generation
  const active = new Map(); // opaque i64 ticket -> host-authenticated authority
  // Telemetry is non-authoritative: an observer must not interrupt a
  // committed transition or reenter a mutating API before its caller returns.
  let notifying = false;
  let observerFailures = 0;
  function assertNotNotifying() {
    if (notifying) fail('state observer cannot mutate admission');
  }
  const emit = event => {
    if (!onEvent) return;
    notifying = true;
    try {
      onEvent(Object.freeze(event));
    } catch {
      observerFailures = Math.min(observerFailures + 1, Number.MAX_SAFE_INTEGER);
    } finally {
      notifying = false;
    }
  };
  // The preview ABI accepts nonnegative signed-i32 addresses only.
  // Full unsigned memory32 addressing needs a separate ABI decision.
  const isPtr = ptr => Number.isInteger(ptr) && ptr >= 0 &&
    ptr <= 0x7fffffff && ptr % 8 === 0;

  function register(ptr) {
    assertNotNotifying();
    if (retired) fail('register after retirement');
    if (!isPtr(ptr)) fail('unaligned or invalid state pointer');
    if (containers.has(ptr)) fail('state pointer reused without retirement');
    if (containers.size >= maxContainers) fail('state container admission capacity');
    if (nextContainerId >= MAX_TICKET_ID) fail('container generation exhausted');
    const meta = {
      ptr, containerId: ++nextContainerId,
      actorIncarnation, generation: 1, retired: false, readers: 0, writer: false,
    };
    containers.set(ptr, meta);
    emit({kind:'register', containerId:meta.containerId, actorIncarnation});
  }

  function enter(ptr, mode) {
    assertNotNotifying();
    if (retired) fail('guest execution retired');
    if (!isPtr(ptr) || !containers.has(ptr)) fail('unknown state container');
    if (mode !== 0 && mode !== 1) fail('invalid lease mode');
    const meta = containers.get(ptr);
    if (meta.retired) fail('state container is retired');
    if (active.size >= maxTickets) fail('state admission capacity');
    // Single synchronous Wasm turn: never attempt to wait on contention.
    if (meta.writer || (mode === 1 && meta.readers !== 0)) {
      fail('synchronous state admission contention; suspension not implemented');
    }
    if (nextTicketId >= MAX_TICKET_ID) fail('ticket sequence exhausted');
    // i64 capability encoding; distinct host instances cannot share tickets.
    const ticket = (BigInt(actorIncarnation) << 32n) | BigInt(++nextTicketId);
    active.set(ticket, {
      containerId:meta.containerId, actorIncarnation,
      generation:meta.generation, mode, meta,
    });
    if (mode === 1) meta.writer = true;
    else meta.readers++;
    emit({kind:'enter', containerId:meta.containerId, mode});
    return ticket;
  }

  function leave(ticket) {
    assertNotNotifying();
    if (typeof ticket !== 'bigint') fail('invalid ticket type');
    const claim = active.get(ticket);
    if (!claim) fail('missing or replayed admission ticket');
    if ((ticket >> 32n) !== BigInt(actorIncarnation)) fail('foreign actor incarnation');
    const meta = claim.meta;
    if (containers.get(meta.ptr) !== meta || meta.containerId !== claim.containerId ||
        meta.generation !== claim.generation ||
        meta.actorIncarnation !== claim.actorIncarnation) {
      fail('stale state generation');
    }
    if (claim.mode === 1) {
      if (!meta.writer) fail('inconsistent writer ledger');
      meta.writer = false;
    } else {
      if (meta.readers === 0) fail('inconsistent reader ledger');
      meta.readers--;
    }
    active.delete(ticket);
    emit({kind:'leave',containerId:claim.containerId,mode:claim.mode});
  }

  function beginRetire(ptr) {
    assertNotNotifying();
    if (!isPtr(ptr) || !containers.has(ptr)) fail('unknown state container');
    const meta = containers.get(ptr);
    if (meta.retired) return;
    meta.retired = true;
    emit({kind:'retire',containerId:meta.containerId});
  }

  function quiescent(ptr) {
    if (!isPtr(ptr) || !containers.has(ptr)) fail('unknown state container');
    const meta = containers.get(ptr);
    return meta.retired && meta.readers === 0 && !meta.writer;
  }

  /** Successful physical completion cannot silently abandon a live ticket. */
  function complete() {
    assertNotNotifying();
    if (terminalOutcome === 'abort') fail('guest execution already aborted');
    if (terminalOutcome === 'complete') return;
    if (active.size) fail('guest returned with unreleased state tickets');
    terminalOutcome = 'complete';
    retired = true;
    for (const meta of containers.values()) meta.retired = true;
    emit({kind:'complete'});
  }

  /** Only invoke AFTER a synchronous guest turn has physically unwound. */
  function abort() {
    assertNotNotifying();
    if (terminalOutcome !== null) return;
    terminalOutcome = 'abort';
    retired = true;
    active.clear();
    for (const meta of containers.values()) {
      meta.retired = true; meta.readers = 0; meta.writer = false;
    }
    emit({kind:'abort'});
  }

  function snapshot() {
    return Object.freeze({
      actorIncarnation, containers: containers.size, active:active.size,
      retired, quiescent:retired && active.size === 0,
    });
  }

  return Object.freeze({
    imports: Object.freeze({
      state_register: register,
      state_enter: enter,
      state_leave: leave,
    }),
    beginRetire, quiescent, complete, abort, snapshot,
    observerFailureCount: () => observerFailures,
  });
}

// Own the complete synchronous turn, including instantiation/start and
// terminal validation. Abort only after the callback has unwound. A rejected
// completion is not a retryable guest return at this outer execution boundary.
const runningTurns = new WeakSet();
export function runScalarStateTurn(runtime, run) {
  // Do not abort a surrounding live turn merely because a nested caller
  // attempts to claim its execution boundary.
  if (runningTurns.has(runtime)) fail('nested synchronous state turn');
  const before = runtime.snapshot();
  if (before.retired || before.active) fail('state turn requires fresh authority');
  runningTurns.add(runtime);
  try {
    const value = run();
    if (typeof value !== 'bigint') fail('guest main must return i64');
    runtime.complete();
    return value;
  } catch (error) {
    runtime.abort();
    throw error;
  } finally {
    runningTurns.delete(runtime);
  }
}
