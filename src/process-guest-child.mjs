import {compileAdmittedCoreGuest} from './guest-admission.mjs';

// Development-only one-shot child. No host imports / WASI / arbitrary guests.
// ENV is deliberately empty; any inherited value is a launcher contract error.
let received = false;
process.on('message', message => {
  if (received) return;
  received = true;
  let reply;
  try {
    if (Object.keys(process.env).length !== 0)
      throw Error('guest process inherited forbidden environment');
    if (!message || message.kind !== 'RUN_ONE' ||
        !(message.bytes instanceof Uint8Array))
      throw Error('invalid guest process request');
    const {admission, module} = compileAdmittedCoreGuest(message.bytes, message.options);
    const instance = new WebAssembly.Instance(module, {});
    const guestEntry = instance.exports[admission.entry];
    if (typeof guestEntry !== 'function') throw Error('missing guest entry');
    const result = guestEntry();
    if (typeof result !== 'bigint') throw Error('guest entry did not return i64');
    reply = {kind: 'RESULT', ok: true, value: result, admission};
  } catch (err) {
    reply = {kind: 'RESULT', ok: false, error: String(err?.message || err).slice(0, 500)};
  }
  // IPC can transfer bigint under the parent's 'advanced' serialization.
  // Disconnecting is not evidence of process termination; the parent awaits it.
  process.send(reply, err => {
    if (err) process.exitCode = 1;
    process.disconnect();
  });
});
