/**
 * Wasm source bridge G0 preflight. No source-level unsafe lowering exists.
 * This scanner is intentionally lexical, not a type/effect checker. The real
 * compiler must separately reject unsupported unsafe operations.
 */
export function rejectUnsupportedUnsafeSource(sourceBytes) {
  // Preserve byte provenance. TextDecoder strips a leading UTF-8 BOM by
  // default, which would make diagnostics point three bytes too early.
  // G0 rejects BOM and binary NUL rather than normalizing signed source.
  const source = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(sourceBytes);
  if (source.startsWith('\uFEFF')) throw Error('wasm source BOM unsupported at byte 0');
  const nul = source.indexOf('\0');
  if (nul !== -1) throw Error('wasm source contains NUL at byte ' +
                             Buffer.byteLength(source.slice(0, nul), 'utf8'));
  let pos = 0;
  const start = c => /[A-Za-z_]/.test(c);
  const part = c => /[A-Za-z0-9_]/.test(c);
  const byteOffset = at => Buffer.byteLength(source.slice(0, at), 'utf8');
  const failure = (reason, at) => { throw Error(reason + ' at byte ' + byteOffset(at)); };

  const unsafeImportPath = path => {
    // Reserved compiler-owned stdlib identity, including legacy spellings.
    // Do not reject quoted text outside an import declaration.
    let normalized = path.split(String.fromCharCode(92)).join('/');
    const reserved = value => {
      const segments = value.split(/[/.:]+/).filter(Boolean);
      const offset = segments[0] === 'atto' || segments[0] === 'ores' ? 1 : 0;
      return segments[offset] === 'std' && segments[offset + 1] === 'unsafe';
    };
    // Never launder an explicitly reserved path through later traversal.
    if (reserved(normalized)) return true;
    // Track the first three logical segments incrementally. Check every
    // intermediate canonical prefix, not just the final path: traversing
    // into a forbidden namespace and then out cannot erase its identity.
    // Each slash component records the prefix length before it was added.
    const prefix = [];
    const stack = [];
    let rootDepth = 0;
    for (const component of normalized.split('/')) {
      if (component === '' || component === '.') continue;
      if (component === '..') {
        if (rootDepth && stack.length <= rootDepth) return true;
        if (stack.length) prefix.length = stack.pop();
        continue;
      }
      stack.push(prefix.length);
      for (const segment of component.split(/[.:]+/)) {
        if (segment && prefix.length < 3) prefix.push(segment);
      }
      const offset = prefix[0] === 'atto' || prefix[0] === 'ores' ? 1 : 0;
      if (prefix[offset] === 'std') {
        if (!rootDepth) rootDepth = stack.length;
        if (prefix[offset + 1] === 'unsafe') return true;
      }
    }
    return false;
  };
  function quoted(quote) {
    const at = pos++;
    while (pos < source.length) {
      if (source[pos] === '\\') { pos += 2; continue; }
      if (source[pos++] === quote) return source.slice(at + 1, pos - 1);
    }
    failure('unterminated quoted literal', at);
  }
  function blockComment() {
    const at = pos;
    pos += 2;
    let depth = 1;
    while (pos < source.length) {
      if (source.startsWith('/*', pos)) {
        if (++depth > 128) failure('comment nesting budget exceeded', at);
        pos += 2;
      } else if (source.startsWith('*/', pos)) {
        depth--; pos += 2;
        if (depth === 0) return;
      } else pos++;
    }
    failure('unterminated block comment', at);
  }
  function template(depth) {
    const at = pos++;
    if (depth > 32) failure('template nesting budget exceeded', at);
    while (pos < source.length) {
      const c = source[pos];
      if (c === '\\') { pos += 2; continue; }
      if (c === '`') { pos++; return; }
      if (source.startsWith('${', pos)) {
        pos += 2;
        code(true, depth + 1);
        continue;
      }
      pos++;
    }
    failure('unterminated template literal', at);
  }
  function code(inInterpolation, depth) {
    let braces = 0;
    let sawImport = false;
    let awaitingImportPath = false;
    while (pos < source.length) {
      const c = source[pos];
      if (source.startsWith('//', pos)) {
        pos += 2;
        while (pos < source.length && !['\n', '\r', '\u0085', '\u2028', '\u2029'].includes(source[pos])) pos++;
        continue;
      }
      if (source.startsWith('/*', pos)) { blockComment(); continue; }
      if (c === '"' || c === "'") {
        const at = pos, value = quoted(c);
        // The external compiler may decode source string escapes. G0 cannot
        // safely interpret escaped import paths, so reject them before any
        // native compiler invocation rather than trusting a raw-byte match.
        if (awaitingImportPath && value.includes(String.fromCharCode(92)))
          failure('wasm escaped import path unavailable in guest domains', at);
        if (awaitingImportPath && unsafeImportPath(value))
          failure('wasm unsafe standard-library import unavailable in guest domains', at);
        awaitingImportPath = false;
        continue;
      }
      if (c === '`') { template(depth + 1); continue; }
      // #unsafe is a Symbol literal, not executable unsafe source.
      if (c === '#') {
        pos++;
        if (source[pos] === '"' || source[pos] === "'") quoted(source[pos]);
        else if (start(source[pos] ?? '')) {
          pos++;
          while (pos < source.length && part(source[pos])) pos++;
        }
        continue;
      }
      if (start(c)) {
        const at = pos++;
        while (pos < source.length && part(source[pos])) pos++;
        const word = source.slice(at, pos);
        if (word === 'unsafe')
          failure('wasm unsafe boundary unsupported: effects and native grants unavailable', at);
        if (word === 'import') sawImport = true;
        if (word === 'from' && sawImport) awaitingImportPath = true;
        continue;
      }
      if (inInterpolation && c === '{') {
        if (++braces > 256) failure('template interpolation brace nesting limit exceeded (256)', pos);
        pos++; continue;
      }
      if (inInterpolation && c === '}') {
        pos++;
        if (braces-- === 0) return;
        continue;
      }
      if (c === ';') { sawImport = false; awaitingImportPath = false; }
      pos++;
    }
    if (inInterpolation) failure('unterminated template interpolation', pos);
  }
  code(false, 0);
}
