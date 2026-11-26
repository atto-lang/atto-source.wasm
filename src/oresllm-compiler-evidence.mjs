// Host-side classification of compiler-stage failures; no native result
// or parity can be inferred merely because an Error object was thrown.
export function assertPinnedCompilerSha256(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw Error('WASM parity requires exact lowercase compiler SHA-256 pin');
  }
  return value;
}
export function semanticCompilerRejection(error) {
  const message=String(error?.message||'');
  // This is specifically the snapshotted compiler-exact child returning
  // nonzero with a diagnostic. A failed clang/linker, nonexistent compiler,
  // EACCES, digest mismatch or timeout is infrastructure failure.
  const matched=/^command failed \([^\r\n)]*compiler-exact\): ([\s\S]+)$/i.exec(message);
  if (!matched) return false;
  // Some adapters serialize line breaks as literal backslash-n. Screen
  // both representations before recognizing a diagnostic.
  const diagnostics=matched[1].replace(/\\r\\n|\\n|\\r/g,'\n');
  if (/\b(?:ENOENT|EACCES|ETIMEDOUT|spawn|timed out|killed|not found|permission denied|no such file|segmentation fault|signal|out of memory|digest mismatch|sha-256 mismatch|exit 12[467]|exit 13[079]|exit 143)\b/i.test(diagnostics)) {
    return false;
  }
  // Named effects have compiler-owned modifier diagnostics. They are not
  // infrastructure failures merely because they use "forbidden"/"removed"
  // instead of "unsupported". Keep these conditional on compiler-exact and
  // the existing infrastructure-denial screen above.
  return /\b(?:syntax|unexpected|unknown|unbound|unsupported|invalid|expected|literal|identifier|parse|operator|division|separator)\b/i.test(diagnostics) ||
    /\b(?:async|critical|suspends)\b[^\r\n]{0,160}\b(?:modifier|forbidden|removed|disallowed|incompatible)\b/i.test(diagnostics);
}
