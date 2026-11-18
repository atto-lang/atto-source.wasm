/**
 * Least-privilege environment for the native AttoLang compiler and clang/lld.
 * Child tools must never inherit GitHub credentials, cloud tokens, runtime
 * loader overrides, proxy secrets or Node injection hooks from the caller.
 * PATH remains a trusted-runner/toolchain responsibility, not an attestation.
 */
export function restrictedBuildEnvironment(host = process.env) {
  // Read PATH once; accessor-backed mutable inputs cannot alter it after
  // validation. Missing PATH falls back to conventional trusted system dirs.
  const original = host.PATH;
  if (original !== undefined &&
      (typeof original !== "string" || original.length === 0 ||
       original.length > 8192 || /[\0\r\n]/.test(original))) {
    throw new TypeError("compiler child PATH must be a bounded nonempty single line");
  }
  const child = {
    PATH: original === undefined ? "/usr/bin:/bin" : original,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8"
  };
  // Windows CreateProcess requires SystemRoot for reliable native lookup.
  // Never propagate arbitrary compiler/CI settings or credential variables.
  if (process.platform === "win32") {
    for (const name of ["SystemRoot", "WINDIR", "PATHEXT"]) {
      const value = host[name];
      if (value !== undefined) {
        if (typeof value !== "string" || value.length > 8192 ||
            /[\0\r\n]/.test(value))
          throw new TypeError("invalid compiler child Windows environment");
        child[name] = value;
      }
    }
  }
  return Object.freeze(child);
}
