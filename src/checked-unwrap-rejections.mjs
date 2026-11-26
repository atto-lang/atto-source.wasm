// Exact Rust #331 typed escaping effect-row negative sources.
// A syntax failure, empty diagnostic or partial guest publication cannot
// impersonate a checked-effect or method-arity rejection.
export const checkedUnwrapRejections = Object.freeze([
  ['empty-throws', '@Throws()\npub fnc main(): int { val Option<int> x = None; return x.unwrap(); }', 'E_EFFECT'],
  ['transitive-empty-throws', 'fnc fail(): int throws(Error) { val Option<int> x = None; return x.unwrap(); }\n@Throws()\npub fnc main(): int { return fail(); }', 'E_EFFECT'],
  ['wrong-arity', 'pub fnc main(): int { val Option<int> x = None; return x.unwrap(42); }', 'E_ARITY']
].map(Object.freeze));
export function verifyCheckedUnwrapRejection(id, output) {
  const entry = checkedUnwrapRejections.find(row => row[0] === id);
  if (!entry || output?.ok !== false || Object.hasOwn(output, 'wasm') ||
      typeof output.diagnostic !== 'string' || output.diagnostic.length > 16384 ||
      /[\r\n]/.test(output.diagnostic) || output.diagnostic.trimEnd().endsWith(':') ||
      !new RegExp('^(?:[0-9]+:[0-9]+: )?' + entry[2] + ': [^\\r\\n]+$').test(output.diagnostic))
    throw new Error('checked unwrap diagnostic mismatch: ' + id);
}
