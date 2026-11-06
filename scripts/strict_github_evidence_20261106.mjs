/**
 * Strict, bounded GitHub REST evidence decoding.  This is a parser, not a CI
 * attestation or an authorization to merge/copy private source.
 *
 * Security boundaries:
 * - bytes, chunk count, JSON depth, token size, array/object size bounded
 * - fatal UTF-8, duplicate decoded JSON keys and nonfinite numbers rejected
 * - use the Response body's stream; never buffer an unlimited HTTP body
 */
const MAX_BYTES = 1024 * 1024;
const MAX_DEPTH = 40;
const MAX_ENTRIES = 10000;
const MAX_KEY = 1024;
const MAX_TOKEN = 128;
const MAX_CHUNKS = 4096;

export class EvidenceRejected extends Error {
  constructor(reason) {
    super('GITHUB_EVIDENCE_DENIED: ' + reason);
    this.name = 'EvidenceRejected';
  }
}

function denied(reason) { throw new EvidenceRejected(reason); }

export function parse_strict_github_json(input) {
  if (!(input instanceof Uint8Array) || input.byteLength === 0 || input.byteLength > MAX_BYTES) {
    denied('invalid or oversized JSON bytes');
  }
  let s;
  try {
    s = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(input);
  } catch {
    denied('invalid UTF-8');
  }
  if (s.charCodeAt(0) === 0xfeff) denied('UTF-8 BOM not permitted');
  let i = 0;
  function skip_space() { while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\r' || s[i] === '\n')) i++; }
  function parse_string() {
    const start = i;
    if (s[i++] !== '"') denied('JSON string expected');
    let escaped = false;
    let closed = false;
    while (i < s.length) {
      const c = s[i++];
      if (!escaped) {
        if (c === '"') { closed = true; break; }
        if (c === '\\') escaped = true;
        else if (c.charCodeAt(0) < 32) denied('control character in string');
      } else {
        if (c === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(s.slice(i, i + 4))) denied('invalid Unicode escape');
          i += 4;
        } else if (!'"\\/bfnrt'.includes(c)) denied('invalid string escape');
        escaped = false;
      }
      if (i - start > MAX_BYTES) denied('unbounded JSON string');
    }
    if (!closed) denied('unterminated JSON string');
    let value;
    try { value = JSON.parse(s.slice(start, i)); } catch { denied('invalid JSON string'); }
    for (let p = 0; p < value.length; p++) {
      const ch = value.charCodeAt(p);
      if (ch >= 0xd800 && ch <= 0xdbff) {
        if (p + 1 >= value.length) denied('unpaired high surrogate');
        const next = value.charCodeAt(++p);
        if (next < 0xdc00 || next > 0xdfff) denied('unpaired high surrogate');
      } else if (ch >= 0xdc00 && ch <= 0xdfff) denied('unpaired low surrogate');
    }
    return value;
  }
  function parse_value(depth) {
    if (depth > MAX_DEPTH) denied('JSON nesting too deep');
    skip_space();
    const c = s[i];
    if (c === '{') {
      i++;
      skip_space();
      const seen = new Set();
      let count = 0;
      if (s[i] === '}') { i++; return; }
      while (true) {
        skip_space();
        const key = parse_string();
        if (key.length > MAX_KEY) denied('JSON key too large');
        if (seen.has(key)) denied('duplicate decoded JSON key');
        seen.add(key);
        if (++count > MAX_ENTRIES) denied('too many JSON members');
        skip_space();
        if (s[i++] !== ':') denied('missing JSON member colon');
        parse_value(depth + 1);
        skip_space();
        if (s[i] === '}') { i++; break; }
        if (s[i++] !== ',') denied('missing JSON member separator');
      }
      return;
    }
    if (c === '[') {
      i++;
      skip_space();
      let count = 0;
      if (s[i] === ']') { i++; return; }
      while (true) {
        if (++count > MAX_ENTRIES) denied('too many JSON array members');
        parse_value(depth + 1);
        skip_space();
        if (s[i] === ']') { i++; break; }
        if (s[i++] !== ',') denied('missing JSON array separator');
      }
      return;
    }
    if (c === '"') { parse_string(); return; }
    for (const literal of ['true', 'false', 'null']) {
      if (s.startsWith(literal, i)) { i += literal.length; return; }
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      const remainder = s.slice(i, i + MAX_TOKEN + 1);
      const m = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(remainder);
      if (!m || m[0].length > MAX_TOKEN) denied('invalid or oversized number');
      if (/[0-9.eE+\-]/.test(s[i + m[0].length] || '')) denied('oversized or invalid numeric token');
      const n = Number(m[0]);
      if (!Number.isFinite(n)) denied('nonfinite number');
      if (!m[0].includes('.') && !/[eE]/.test(m[0]) && !Number.isSafeInteger(n)) denied('unsafe integer');
      i += m[0].length;
      return;
    }
    denied('invalid JSON value');
  }
  parse_value(0);
  skip_space();
  if (i !== s.length) denied('trailing JSON material');
  let value;
  try { value = JSON.parse(s); } catch { denied('JSON decode rejected'); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) denied('top-level GitHub evidence must be an object');
  return value;
}

export async function read_strict_github_response(response) {
  if (!response || response.status !== 200 || !response.body || typeof response.body.getReader !== 'function') {
    denied('GitHub response is not a successful stream');
  }
  const declared = response.headers?.get?.('content-length');
  if (declared != null && (!/^(?:0|[1-9][0-9]*)$/.test(declared)
      || !Number.isSafeInteger(Number(declared)) || Number(declared) > MAX_BYTES)) {
    denied('invalid or oversized declared content length');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let count = 0;
  let total = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || ++count > MAX_CHUNKS) denied('invalid streamed response chunks');
      total += value.byteLength;
      if (total > MAX_BYTES) denied('streamed response size exceeded');
      chunks.push(value);
    }
  } catch (err) {
    try { await reader.cancel(); } catch { /* preserve the original rejection */ }
    if (err instanceof EvidenceRejected) throw err;
    denied('stream read failed');
  } finally {
    reader.releaseLock();
  }
  // Undici may decompress gzip while retaining the wire Content-Length header.
  if (declared != null && !response.headers?.get?.('content-encoding')
      && Number(declared) !== total) denied('mismatched response content length');
  const all = new Uint8Array(total);
  let cursor = 0;
  for (const bytes of chunks) { all.set(bytes, cursor); cursor += bytes.byteLength; }
  return parse_strict_github_json(all);
}
