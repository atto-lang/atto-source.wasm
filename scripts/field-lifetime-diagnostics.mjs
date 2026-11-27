import assert from 'node:assert/strict';

const decoder = new TextDecoder('utf-8', {fatal: true});
const MAX_DIAGNOSTIC_BYTES = 65536;

// attoc writes exactly one diagnostic: PATH: LINE:COL: CODE: message.
// Do not accept a code mentioned only in another diagnostic's message.
export function requireNativeDiagnostic(bytes, path, expectedCode) {
  assert.ok(bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= MAX_DIAGNOSTIC_BYTES, 'invalid native diagnostic size');
  assert.match(expectedCode, /^E_[A-Z0-9_]+$/);
  const prefix = path + ': ';
  const diagnostic = decoder.decode(bytes);
  assert.ok(diagnostic.startsWith(prefix), 'native diagnostic source mismatch');
  const match = /^\d+:\d+: (E_[A-Z0-9_]+): [^\r\n]+\r?\n$/.exec(diagnostic.slice(prefix.length));
  assert.ok(match, 'invalid native diagnostic format');
  assert.equal(match[1], expectedCode, 'native diagnostic code mismatch');
}

// The browser ABI supplies a NUL-terminated UTF-8 diagnostic. Scan only a
// fixed budget, rather than traversing the rest of linear memory.
export function readBrowserDiagnostic(memory, offset) {
  assert.ok(memory instanceof Uint8Array && Number.isSafeInteger(offset) && offset >= 0 && offset < memory.length, 'invalid diagnostic offset');
  const limit = Math.min(memory.length, offset + MAX_DIAGNOSTIC_BYTES + 1);
  let end = offset;
  while (end < limit && memory[end] !== 0) end++;
  assert.ok(end < limit && end > offset, 'empty, oversized or unterminated diagnostic');
  return decoder.decode(memory.subarray(offset, end));
}

/** Browser compiler ABI v2 has exactly two normal return statuses. */
export function requireBrowserCompileStatus(status) {
  assert.ok(status === 0 || status === 1, 'unexpected browser compiler status');
  return status;
}

/** Diagnostic.render() emits one CODE: message for the canonical fixtures. */
export function requireBrowserDiagnostic(diagnostic, expectedCode) {
  assert.match(expectedCode, /^E_[A-Z0-9_]+$/);
  assert.equal(typeof diagnostic, 'string');
  const match = /^(E_[A-Z0-9_]+): ([^\r\n]+)$/.exec(diagnostic);
  assert.ok(match && match[0] === diagnostic && match[2].trim().length > 0, 'invalid browser diagnostic format');
  assert.equal(match[1], expectedCode, 'browser diagnostic code mismatch');
}
