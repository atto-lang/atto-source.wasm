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
  const diagnostics=matched[1];
  if (/\b(?:ENOENT|EACCES|ETIMEDOUT|spawn|timed out|killed|not found|permission denied|no such file|segmentation fault|signal|out of memory|digest mismatch|sha-256 mismatch|exit 12[467]|exit 13[079]|exit 143)\b/i.test(diagnostics)) {
    return false;
  }
  return /\b(?:syntax|unexpected|unknown|unbound|unsupported|invalid|expected|literal|identifier|parse|operator|division|separator)\b/i.test(diagnostics);
}
