import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {snapshotGuestBytes} from './snapshot-guest-bytes.mjs';

// This is a process-killable JIT prototype, not an OS-sandboxed tenant runtime.
// It does not establish cgroups, seccomp, user namespaces or RSS/native-JIT limits.
const MAX_CONCURRENT = 4;
let concurrent = 0;
const allowed = new Set(['unsafeDevelopmentMode', 'expectedSha256', 'entry',
  'maxMemoryPages', 'maxModuleBytes', 'timeoutMs']);
const childPath = fileURLToPath(new URL('./process-guest-child.mjs', import.meta.url));
const shaPattern = /^[a-f0-9]{64}$/;
const ADMISSION_KEYS = new Set(['schemaVersion','profile','sha256','bytes','entry',
  'memoryInitialPages','memoryMaximumPages','imports','hostCapabilities']);
const RESULT_KEYS = new Set(['kind','ok','value','admission']);

function checkInt(n, min, max, label) {
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new TypeError(`invalid ${label}`);
}
function verifyResponse(message, bytes, hash, entry, maxMemoryPages) {
  if (message === null || typeof message !== 'object' || Array.isArray(message) ||
      Object.getPrototypeOf(message) !== Object.prototype ||
      message.kind !== 'RESULT' || typeof message.ok !== 'boolean') {
    throw Error('invalid process guest response');
  }
  if (message.ok === false) throw Error('guest rejected or failed: ' +
    String(message.error || 'unknown guest failure').slice(0, 500));
  const a = message.admission;
  if (Reflect.ownKeys(message).length !== RESULT_KEYS.size ||
      Reflect.ownKeys(message).some(k => !RESULT_KEYS.has(k)) ||
      !a || typeof a !== 'object' || Array.isArray(a) ||
      Object.getPrototypeOf(a) !== Object.prototype ||
      Reflect.ownKeys(a).length !== ADMISSION_KEYS.size ||
      Reflect.ownKeys(a).some(k => !ADMISSION_KEYS.has(k))) {
    throw Error('invalid process guest response fields');
  }
  if (message.ok !== true || typeof message.value !== 'bigint' ||
      a.schemaVersion !== 1 || a.profile !== 'core-wasm.i64-v1' ||
      a.entry !== entry || a.bytes !== bytes || a.sha256 !== hash ||
      a.imports !== 0 || a.hostCapabilities !== 0 ||
      !Number.isSafeInteger(a.memoryInitialPages) ||
      !Number.isSafeInteger(a.memoryMaximumPages) ||
      a.memoryInitialPages < 0 || a.memoryInitialPages > a.memoryMaximumPages ||
      a.memoryMaximumPages > maxMemoryPages) {
    throw Error('invalid process guest response');
  }
  // Never expose a mutable or extensible purported proof object.
  return Object.freeze({value: message.value, admission: Object.freeze({...a}),
    execution: Object.freeze({profile: 'experimental-node-process-wasm-jit',
      actualWasmGuestExecuted: true, hostileSandboxCertified: false,
      attolangActorExecuted: false})});
}

/**
 * Isolated OS PROCESS (not OS sandbox): runs the existing strict zero-import
 * scalar Wasm admission and actual V8 JIT inside a one-shot child. The child
 * is killed on timeout and result is released only after child termination.
 * The caller MUST consciously opt into an unsafe development-only execution.
 */
export async function runExperimentalProcessGuest(input, options = {}) {
  // Reject accessor-backed configuration before reading any option. Snapshot
  // each own data property once, so admission and execution cannot observe
  // different values from getters or a mutated options object.
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.getPrototypeOf(options) !== Object.prototype) {
    throw new TypeError('invalid process runner options');
  }
  const descriptors = Object.getOwnPropertyDescriptors(options);
  if (Reflect.ownKeys(descriptors).some(k =>
    typeof k !== 'string' || !allowed.has(k) ||
    !Object.hasOwn(descriptors[k], 'value'))) {
    throw new TypeError('invalid process runner options');
  }
  const config = Object.fromEntries(Object.entries(descriptors).map(
    ([key, d]) => [key, d.value]));
  if (config.unsafeDevelopmentMode !== true) {
    throw Error('UNTRUSTED_PROCESS_SANDBOX_NOT_IMPLEMENTED: development opt-in required');
  }
  const {expectedSha256, entry = 'main', maxMemoryPages = 2,
    maxModuleBytes = 16 * 1024 * 1024, timeoutMs = 2000} = config;
  checkInt(timeoutMs, 1, 30000, 'timeoutMs');
  checkInt(maxModuleBytes, 8, 16 * 1024 * 1024, 'maxModuleBytes');
  checkInt(maxMemoryPages, 1, 256, 'maxMemoryPages');
  if (typeof entry !== 'string' || !/^[A-Za-z_][A-Za-z_0-9]*$/.test(entry))
    throw new TypeError('invalid guest entry');
  if (expectedSha256 !== undefined &&
      (typeof expectedSha256 !== 'string' || !shaPattern.test(expectedSha256))) {
    throw new TypeError('invalid pinned SHA-256');
  }
  // Copy before launching; never give the child a mutable caller-owned view.
  const bytes = snapshotGuestBytes(input, maxModuleBytes);
  const actualHash = createHash('sha256').update(bytes).digest('hex');
  if (expectedSha256 !== undefined && actualHash !== expectedSha256)
    throw Error('guest artifact SHA-256 mismatch');
  if (concurrent >= MAX_CONCURRENT) throw Error('guest process concurrency quota exceeded');
  concurrent++;
  try {
    return await new Promise((resolve, reject) => {
      let child, timer, response, validated, failure, finalized = false;
      const kill = () => {
        if (child && child.exitCode === null && child.signalCode === null) {
          try { child.kill('SIGKILL'); } catch (err) { failure ||= err; }
        }
      };
      const fail = err => { failure ||= err; kill(); };
      const finish = () => {
        if (finalized) return;
        finalized = true;
        clearTimeout(timer);
        // We reach here only on close: do not free quota while code may run.
        concurrent--;
        if (failure) return reject(failure);
        if (!validated) return reject(Error('guest process response was not validated'));
        resolve(validated);
      };
      try {
        child = spawn(process.execPath,
          ['--max-old-space-size=64', childPath],
          {env: {}, stdio: ['ignore','ignore','ignore','ipc'],
            serialization: 'advanced', windowsHide: true});
        child.on('message', message => {
          if (response !== undefined) return fail(Error('duplicate process guest response'));
          response = message;
          try {
            validated = verifyResponse(message, bytes.length, actualHash, entry, maxMemoryPages);
          } catch (err) {
            return fail(err);
          }
          // Do not kill a successful child before its normal IPC disconnect.
          // A nonzero exit after a valid reply is still an execution failure.
          // The deadline remains active until close and kills any stuck child.
        });
        child.once('error', err => fail(new Error('guest process launch failed: ' + err.message)));
        child.once('close', (code, signal) => {
          if (!failure && (code !== 0 || signal !== null))
            failure = Error('guest process did not exit cleanly: ' + String(code ?? signal));
          if (response === undefined && !failure)
            failure = Error('guest process exited without result');
          finish();
        });
        timer = setTimeout(() => fail(Error('guest process execution deadline exceeded')), timeoutMs);
        child.send({kind: 'RUN_ONE', bytes, options: {
          expectedSha256: actualHash, entry, maxMemoryPages, maxModuleBytes
        }}, err => { if (err) fail(Error('guest process IPC failed: ' + err.message)); });
      } catch (err) {
        if (child) fail(err);
        else { concurrent--; reject(err); }
      }
    });
  } catch (err) {
    throw err;
  }
}
