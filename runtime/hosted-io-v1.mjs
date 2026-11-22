// Host-only Atto/Wasm I/O adapter. NOT linked to guest imports or an Atto compiler.
// Provides explicitly granted loopback HTTP and tenant-private VFS for development.
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', {fatal: true});

export class HostIoError extends Error {
  constructor(code) { super(code); this.name = 'HostIoError'; this.code = code; }
}
// Host-side mappings for the public Atto FsErrorKind vocabulary. The compiled
// Atto Error hierarchy and trap -> Result lowering still require guest ABI.
export const FsErrorKind = Object.freeze({
  not_found: 'not_found', already_exists: 'already_exists',
  permission_denied: 'permission_denied', invalid_path: 'invalid_path',
  invalid_handle: 'invalid_handle',
  not_file: 'not_file', not_directory: 'not_directory',
  directory_not_empty: 'directory_not_empty', invalid_option: 'invalid_option',
  invalid_utf8: 'invalid_utf8', closed: 'closed',
  cancelled: 'cancelled', resource_limit: 'resource_limit',
  busy: 'busy', unsupported: 'unsupported', io_error: 'io_error',
  unknown_outcome: 'unknown_outcome'
});
const FS_KINDS = Object.freeze({
  E_FS_NOT_FOUND: FsErrorKind.not_found,
  E_FS_EXISTS: FsErrorKind.already_exists,
  E_FS_PATH: FsErrorKind.invalid_path,
  E_FS_NOT_FILE: FsErrorKind.not_file,
  E_FS_NOT_DIR: FsErrorKind.not_directory,
  E_FS_NOT_EMPTY: FsErrorKind.directory_not_empty,
  E_FS_OPTIONS: FsErrorKind.invalid_option,
  E_FS_HANDLE: FsErrorKind.invalid_handle,
  E_FS_BYTES: FsErrorKind.invalid_option,
  E_FS_OFFSET: FsErrorKind.invalid_option,
  E_FS_CLOSED: FsErrorKind.closed,
  E_FS_BUSY: FsErrorKind.busy,
  E_FS_LIMIT: FsErrorKind.resource_limit,
  E_FS_IO: FsErrorKind.io_error
});
export class FsError extends HostIoError {
  constructor(code) {
    super(code);
    this.name = 'FsError';
    this.kind = FS_KINDS[code] ?? FsErrorKind.io_error;
  }
}
function fail(code) {
  if (code.startsWith('E_FS_')) throw new FsError(code);
  throw new HostIoError(code);
}
// Translate host-only filesystem statuses to a stable public error category.
// This does not export a guest FsError value or intercept panic/raise.
export function fs_error_kind(error) {
  if (!(error instanceof HostIoError)) return FsErrorKind.io_error;
  if (error instanceof FsError) return error.kind;
  if (error.code==='E_IO_PERMISSION') return FsErrorKind.permission_denied;
  if (error.code==='E_IO_STALE' || error.code==='E_IO_CLOSED')
    return FsErrorKind.closed;
  if (error.code==='E_IO_CANCELLED') return FsErrorKind.cancelled;
  if (error.code==='E_IO_BUSY' || error.code==='E_NET_BUSY') return FsErrorKind.busy;
  if (error.code==='E_INVALID_UTF8') return FsErrorKind.invalid_utf8;
  return FsErrorKind.io_error;
}

const boundedInteger = (value, min, max) =>
  Number.isSafeInteger(value) && value >= min && value <= max;

function checkedPath(path) {
  // Reject unbounded strings before TextEncoder allocates its output. UTF-8 is
  // at most 3 bytes per UTF-16 unit for well-formed text, so a 256-unit input
  // is a safe preflight ceiling; the actual byte budget is then enforced.
  if (typeof path !== 'string' || path.length < 1 || path.length > 256 ||
      path.startsWith('/') || path.includes('\\') || path.includes(':') ||
      !path.isWellFormed() ||
      /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(path) ||
      textEncoder.encode(path).length > 256) fail('E_FS_PATH');
  const p = path.startsWith('./') ? path.slice(2) : path;
  const parts = p.split('/');
  if (parts.some(s => !s || s === '.' || s === '..')) fail('E_FS_PATH');
  return parts.join('/');
}


// Path value normalization is lexical only: remove redundant separators and
// '.', but NEVER collapse '..' across the tenant boundary.
function normalizedPath(value) {
  // Reject large untrusted strings before split/filter allocate per-segment
  // arrays. The final byte limit remains enforced by checkedPath().
  if (typeof value!=='string' || value.length<1 || value.length>1024 ||
      !value.isWellFormed() ||
      value.startsWith('/') || value.includes('\\') || value.includes(':') ||
      value.includes('\0')) fail('E_FS_PATH');
  const parts=value.split('/').filter(part=>part!=='' && part!=='.');
  if (parts.some(part=>part==='..') || parts.length===0) fail('E_FS_PATH');
  return checkedPath(parts.join('/'));
}
function checkedDirectoryPath(value) {
  if (value==='.' || value==='./') return ''; // Read-only tenant root selector.
  return checkedPath(value);
}
function pathParent(p) {
  const slash = p.lastIndexOf('/');
  return slash < 0 ? '' : p.slice(0, slash);
}
function scalarCompare(a,b) {
  const left = Array.from(a, c => c.codePointAt(0));
  const right = Array.from(b, c => c.codePointAt(0));
  for (let i=0;i<Math.min(left.length,right.length);i++) {
    if (left[i] !== right[i]) return left[i]-right[i];
  }
  return left.length-right.length;
}
// Pure lexical paths; no filesystem resolution, symlink access or authority.
export class FsPath {
  constructor(value) {
    this.value=(value==='.' || value==='./') ? '.' : normalizedPath(value);
    Object.freeze(this);
  }
  toString() { return this.value; }
  join(child) { return new FsPath(this.value==='.' ? String(child) : this.value+'/'+String(child)); }
  parent() {
    if (this.value==='.') return null;
    const parent=pathParent(this.value);
    return new FsPath(parent || '.');
  }
  file_name() {
    return this.value==='.' ? null : this.value.slice(this.value.lastIndexOf('/')+1);
  }
  extension() {
    const name=this.file_name();
    if (name===null) return null;
    const at=name.lastIndexOf('.');
    return at<=0 ? null : name.slice(at+1);
  }
  normalize() { return this; }
}
export class FsPathBuf {
  #value;
  constructor(value) { this.#value=(value==='.' || value==='./') ? '.' : normalizedPath(value); }
  to_path() { return new FsPath(this.#value); }
  push(value) {
    this.#value=normalizedPath(this.#value==='.' ? String(value) : this.#value+'/'+String(value));
  }
  pop() {
    if (this.#value==='.') return null;
    const old=this.#value;
    this.#value=pathParent(old) || '.';
    return old.slice(old.lastIndexOf('/')+1);
  }
  toString() { return this.#value; }
}
export function path_join(base,child) { return new FsPath(String(base)).join(child); }
export function path_parent(value) { return new FsPath(String(value)).parent(); }
export function path_file_name(value) { return new FsPath(String(value)).file_name(); }
export function path_extension(value) { return new FsPath(String(value)).extension(); }
export function path_normalize(value) { return new FsPath(String(value)); }

function allowedUrl(input, origins, loopbackOnly) {
  if (typeof input !== 'string' || !input || input.length > 2048 ||
      textEncoder.encode(input).length > 2048 ||
      /[\u0000-\u0020\\]/u.test(input)) fail('E_NET_URL');
  let parsed;
  try { parsed = new URL(input); } catch { fail('E_NET_URL'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password ||
      parsed.hash || !origins.has(parsed.origin)) fail('E_NET_PERMISSION');
  const host = parsed.hostname;
  const isLoopback = host === '127.0.0.1' || host === '[::1]';
  if (loopbackOnly && !isLoopback) fail('E_NET_PERMISSION');
  if (parsed.protocol === 'http:' && !isLoopback) fail('E_NET_PERMISSION');
  // A production adapter must validate DNS, resolved IPs and TLS before any
  // non-loopback origin can be enabled; this first implementation is loopback-only.
  return parsed;
}

export class TenantHostedIoV1 {
  #tenantId;
  #actors = new Map(); // Active actor grants only.
  #actorGenerations = new Map(); // Bounded last generation per actor ID.
  #files = new Map();
  #dirs = new Set(['']); // Empty path is the non-removable tenant root.
  #handles = new Map(); // Opaque handle -> actor generation and cursor.
  #fileObjects = new WeakMap(); // Host-owned File instances, not guessed paths.
  #live = new Set();
  #fileBytes = 0;
  #closed = false;
  #allowedOrigins;
  #fetch;
  #maxBodyBytes;
  #maxFileBytes;
  #maxTotalBytes;
  #maxFiles;
  #maxDirs;
  #maxHandles;
  #maxInflight;
  #maxActors;
  #maxActorIds;
  #timeoutMs;

  constructor({tenantId, allowedOrigins = [], fetchImpl = globalThis.fetch,
    maxBodyBytes = 1024 * 1024, maxFileBytes = 1024 * 1024,
    maxTotalBytes = 4 * 1024 * 1024, maxFiles = 32,
    maxDirs = 128, maxHandles = 64,
    maxInflight = 8, maxActors = 128, maxActorIds = 4096,
    timeoutMs = 30000} = {}) {
    if (typeof tenantId !== 'string' || !tenantId || tenantId.length > 128 ||
        !Array.isArray(allowedOrigins) || allowedOrigins.length > 32 ||
        typeof fetchImpl !== 'function' ||
        !boundedInteger(maxBodyBytes, 1, 16 * 1024 * 1024) ||
        !boundedInteger(maxFileBytes, 1, 16 * 1024 * 1024) ||
        !boundedInteger(maxTotalBytes, 1, 64 * 1024 * 1024) ||
        !boundedInteger(maxFiles, 1, 1024) ||
        !boundedInteger(maxDirs, 1, 4096) ||
        !boundedInteger(maxHandles, 1, 1024) ||
        !boundedInteger(maxInflight, 1, 64) ||
        !boundedInteger(maxActors, 1, 4096) ||
        !boundedInteger(maxActorIds, maxActors, 65536) ||
        !boundedInteger(timeoutMs, 1, 120000)) fail('E_IO_CONFIG');
    this.#tenantId = tenantId;
    this.#maxBodyBytes = maxBodyBytes;
    this.#maxFileBytes = maxFileBytes;
    this.#maxTotalBytes = maxTotalBytes;
    this.#maxFiles = maxFiles;
    this.#maxDirs = maxDirs;
    this.#maxHandles = maxHandles;
    this.#maxInflight = maxInflight;
    this.#maxActors = maxActors;
    this.#maxActorIds = maxActorIds;
    this.#timeoutMs = timeoutMs;
    this.#fetch = fetchImpl;
    this.#allowedOrigins = new Set();
    for (const origin of allowedOrigins) {
      if (typeof origin !== 'string' || origin.length > 2048 ||
          !origin.isWellFormed()) fail('E_IO_CONFIG');
      let url;
      try { url = new URL(origin); } catch { fail('E_IO_CONFIG'); }
      if (url.origin !== origin || url.pathname !== '/' || url.search || url.hash ||
          url.username || url.password ||
          !['http:', 'https:'].includes(url.protocol) ||
          !['127.0.0.1', '[::1]'].includes(url.hostname)) fail('E_IO_CONFIG');
      this.#allowedOrigins.add(origin);
    }
  }

  get tenant_id() { return this.#tenantId; }
  get file_count() { return this.#files.size; }
  get dir_count() { return this.#dirs.size-1; }
  get handle_count() { return this.#handles.size; }
  get byte_count() { return this.#fileBytes; }

  open_actor(actorId, generation, grants = {}) {
    if (this.#closed) fail('E_IO_CLOSED');
    if (!grants || typeof grants!=='object' || Array.isArray(grants))
      fail('E_IO_CONFIG');
    const allowedGrants = new Set([
      'read','write','network','directories','remove','recursive'
    ]);
    if (Object.keys(grants).some(key=>!allowedGrants.has(key)))
      fail('E_IO_CONFIG');
    const {read = false, write = false, network = false,
      directories = false, remove = false, recursive = false} = grants;
    if (!boundedInteger(actorId, 1, Number.MAX_SAFE_INTEGER) ||
        !boundedInteger(generation, 1, Number.MAX_SAFE_INTEGER) ||
        [read, write, network, directories, remove, recursive].some(v => typeof v !== 'boolean')) fail('E_IO_CONFIG');
    const previous = this.#actors.get(actorId);
    const last = this.#actorGenerations.get(actorId);
    if (last !== undefined && generation <= last) fail('E_IO_STALE');
    if (last === undefined && this.#actorGenerations.size >= this.#maxActorIds)
      fail('E_IO_BUSY');
    if (!previous && this.#actors.size >= this.#maxActors) fail('E_IO_BUSY');
    if (previous) this.#revoke(previous);
    const token = Object.freeze({});
    this.#actorGenerations.set(actorId, generation);
    this.#actors.set(actorId, {generation, token, read, write, network,
      directories, remove, recursive, active: true});
    return token;
  }

  #actor(token, permission) {
    if (this.#closed) fail('E_IO_CLOSED');
    for (const actor of this.#actors.values()) {
      if (actor.active && actor.token === token) {
        if (permission && !actor[permission]) fail('E_IO_PERMISSION');
        return actor;
      }
    }
    fail('E_IO_STALE');
  }
  // Trusted host-only admission proof after an async completion boundary.
  // Does not grant new rights; prevents stale actor work from publishing
  // successful results after revoke/restart or tenant teardown.
  assert_actor_active(token) {
    this.#actor(token,null);
    return true;
  }
  #revoke(actor) {
    actor.active = false;
    for (const [handle, entry] of this.#handles) {
      if (entry.actor === actor) { entry.closed=true; this.#handles.delete(handle); }
    }
    for (const job of this.#live) {
      if (job.actor === actor) {
        job.reject(new HostIoError('E_IO_CANCELLED'));
      }
    }
  }
  revoke_actor(actorId, generation) {
    const actor = this.#actors.get(actorId);
    if (!actor || actor.generation !== generation || !actor.active) fail('E_IO_STALE');
    this.#revoke(actor);
    // The separately bounded generation ledger remains after active removal.
    this.#actors.delete(actorId);
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const actor of this.#actors.values()) this.#revoke(actor);
    this.#actors.clear();
    this.#actorGenerations.clear();
    this.#files.clear();
    this.#dirs.clear();
    this.#handles.clear();
    this.#fileBytes = 0;
  }

  async write_text(token, pathOrFile, text) {
    this.#actor(token, 'write');
    if (typeof text !== 'string' || !text.isWellFormed()) fail('E_INVALID_UTF8');
    // A code unit produces >=1 UTF-8 byte; preflight before allocation.
    if (text.length > this.#maxFileBytes) fail('E_FS_LIMIT');
    const bytes=textEncoder.encode(text);
    if (bytes.byteLength > this.#maxFileBytes) fail('E_FS_LIMIT');
    // File overload writes from the CURRENT cursor and never closes the file.
    if (this.#fileObjects.has(pathOrFile)) {
      const handle=this.#fileObjectHandle(token,pathOrFile,'write');
      this.#writeEntireHandle(token,handle,bytes);
      return;
    }
    if (typeof pathOrFile==='object' && !(pathOrFile instanceof FsPath) &&
        !(pathOrFile instanceof FsPathBuf)) fail('E_FS_HANDLE');
    this.#storeFile(checkedPath(String(pathOrFile)),bytes);
  }
  async read_text(token, pathOrFile) {
    this.#actor(token, 'read');
    // A File overload reads CURRENT cursor -> EOF and leaves file open.
    const bytes=this.#fileObjects.has(pathOrFile)
      ? this.#readRemainingHandle(token,this.#fileObjectHandle(token,pathOrFile,'read'))
      : (() => {
          if (typeof pathOrFile==='object' && !(pathOrFile instanceof FsPath) &&
              !(pathOrFile instanceof FsPathBuf)) fail('E_FS_HANDLE');
          return this.#file(checkedPath(String(pathOrFile)));
        })();
    try { return textDecoder.decode(bytes); } catch { fail('E_INVALID_UTF8'); }
  }


  // File and directory operations below implement a real tenant-private VFS,
  // not a native guest import or a host-disk filesystem. No symlinks/devices.
  #file(p) {
    if (this.#dirs.has(p)) fail('E_FS_NOT_FILE');
    const data=this.#files.get(p);
    if (!data) fail('E_FS_NOT_FOUND');
    return data;
  }
  #storeFile(p, input) {
    if (this.#dirs.has(p)) fail('E_FS_NOT_FILE');
    if (!this.#dirs.has(pathParent(p))) fail('E_FS_NOT_FOUND');
    if (!(input instanceof Uint8Array)) fail('E_FS_BYTES');
    const bytes=new Uint8Array(input); // Never retain caller-owned memory.
    if (bytes.byteLength > this.#maxFileBytes) fail('E_FS_LIMIT');
    const prior=this.#files.get(p);
    if (!prior && this.#files.size >= this.#maxFiles) fail('E_FS_LIMIT');
    const total=this.#fileBytes-(prior?.byteLength ?? 0)+bytes.byteLength;
    if (!Number.isSafeInteger(total) || total>this.#maxTotalBytes) fail('E_FS_LIMIT');
    this.#files.set(p,bytes);
    this.#fileBytes=total;
  }
  #invalidateHandles(prefix) {
    for (const [handle,entry] of this.#handles) {
      if (entry.path===prefix || entry.path.startsWith(prefix+'/')) {
        entry.closed=true; this.#handles.delete(handle);
      }
    }
  }
  async read_file(token,pathOrFile) {
    this.#actor(token,'read');
    if (this.#fileObjects.has(pathOrFile)) {
      return this.#readRemainingHandle(token,this.#fileObjectHandle(token,pathOrFile,'read'));
    }
    if (typeof pathOrFile==='object' && !(pathOrFile instanceof FsPath) &&
        !(pathOrFile instanceof FsPathBuf)) fail('E_FS_HANDLE');
    return new Uint8Array(this.#file(checkedPath(String(pathOrFile))));
  }
  async write_file(token,pathOrFile,bytes) {
    this.#actor(token,'write');
    if (this.#fileObjects.has(pathOrFile)) {
      this.#writeEntireHandle(token,this.#fileObjectHandle(token,pathOrFile,'write'),bytes);
      return;
    }
    if (typeof pathOrFile==='object' && !(pathOrFile instanceof FsPath) &&
        !(pathOrFile instanceof FsPathBuf)) fail('E_FS_HANDLE');
    this.#storeFile(checkedPath(String(pathOrFile)),bytes);
  }
  async append_file(token,path,bytes) {
    this.#actor(token,'write');
    const p=checkedPath(String(path));
    if (!(bytes instanceof Uint8Array)) fail('E_FS_BYTES');
    if (this.#dirs.has(p)) fail('E_FS_NOT_FILE');
    const old=this.#files.get(p) ?? new Uint8Array();
    if (bytes.byteLength > this.#maxFileBytes-old.length) fail('E_FS_LIMIT');
    const data=new Uint8Array(old.length+bytes.byteLength);
    data.set(old); data.set(bytes,old.length);
    this.#storeFile(p,data);
  }
  async copy_file(token,source,destination) {
    this.#actor(token,'read'); this.#actor(token,'write');
    const from=checkedPath(String(source)), to=checkedPath(String(destination));
    const bytes=this.#file(from);
    if (this.#files.has(to) || this.#dirs.has(to)) fail('E_FS_EXISTS');
    this.#storeFile(to,bytes);
  }
  async rename(token,source,destination) {
    this.#actor(token,'write'); this.#actor(token,'remove');
    const from=checkedPath(String(source)), to=checkedPath(String(destination));
    if (from===to || to.startsWith(from+'/')) fail('E_FS_PATH');
    if (this.#files.has(to) || this.#dirs.has(to)) fail('E_FS_EXISTS');
    if (!this.#dirs.has(pathParent(to))) fail('E_FS_NOT_FOUND');
    if (this.#files.has(from)) {
      const bytes=this.#files.get(from);
      this.#files.delete(from); this.#files.set(to,bytes);
    } else if (this.#dirs.has(from)) {
      this.#actor(token,'directories');
      const dirs=[...this.#dirs].filter(p=>p===from || p.startsWith(from+'/'));
      const files=[...this.#files].filter(([p])=>p.startsWith(from+'/'));
      // Directory rename is one in-memory transaction with no partial move.
      for (const p of dirs) this.#dirs.delete(p);
      for (const p of dirs) this.#dirs.add(to+p.slice(from.length));
      for (const [p] of files) this.#files.delete(p);
      for (const [p,bytes] of files) this.#files.set(to+p.slice(from.length),bytes);
    } else fail('E_FS_NOT_FOUND');
    this.#invalidateHandles(from);
  }
  async remove_file(token,path) {
    this.#actor(token,'write'); this.#actor(token,'remove');
    const p=checkedPath(String(path)), bytes=this.#file(p);
    this.#files.delete(p); this.#fileBytes-=bytes.byteLength;
    this.#invalidateHandles(p);
  }
  async create_dir(token,path) {
    this.#actor(token,'write'); this.#actor(token,'directories');
    const p=checkedPath(String(path));
    if (this.#files.has(p) || this.#dirs.has(p)) fail('E_FS_EXISTS');
    if (!this.#dirs.has(pathParent(p))) fail('E_FS_NOT_FOUND');
    if (this.#dirs.size-1 >= this.#maxDirs) fail('E_FS_LIMIT');
    this.#dirs.add(p);
  }
  async create_dir_all(token,path) {
    this.#actor(token,'write'); this.#actor(token,'directories');
    const p=checkedPath(String(path));
    const parts=p.split('/'), pending=[];let built='';
    for (const part of parts) {
      built=built ? built+'/'+part : part;
      if (this.#files.has(built)) fail('E_FS_NOT_DIR');
      if (!this.#dirs.has(built)) pending.push(built);
    }
    if (pending.length > this.#maxDirs-(this.#dirs.size-1)) fail('E_FS_LIMIT');
    for (const dir of pending) this.#dirs.add(dir);
  }
  async read_dir(token,path) {
    this.#actor(token,'read');
    const p=checkedDirectoryPath(String(path));
    if (!this.#dirs.has(p)) {
      if (this.#files.has(p)) fail('E_FS_NOT_DIR');
      fail('E_FS_NOT_FOUND');
    }
    const entries=[];
    for (const dir of this.#dirs) {
      if (dir && pathParent(dir)===p) entries.push(Object.freeze({
        name:p ? dir.slice(p.length+1) : dir,path:dir,kind:'directory'}));
    }
    for (const filename of this.#files.keys()) {
      if (pathParent(filename)===p) entries.push(Object.freeze({
        name:p ? filename.slice(p.length+1) : filename,path:filename,kind:'file'}));
    }
    entries.sort((a,b)=>scalarCompare(a.name,b.name));
    return Object.freeze(entries);
  }
  async remove_dir(token,path) {
    this.#actor(token,'write'); this.#actor(token,'directories');
    this.#actor(token,'remove');
    const p=checkedPath(String(path));
    if (!this.#dirs.has(p)) {
      if (this.#files.has(p)) fail('E_FS_NOT_DIR');
      fail('E_FS_NOT_FOUND');
    }
    if ([...this.#dirs].some(x=>x.startsWith(p+'/')) ||
        [...this.#files.keys()].some(x=>x.startsWith(p+'/'))) fail('E_FS_NOT_EMPTY');
    this.#dirs.delete(p); this.#invalidateHandles(p);
  }
  async remove_dir_all(token,path) {
    this.#actor(token,'write'); this.#actor(token,'directories');
    this.#actor(token,'remove'); this.#actor(token,'recursive');
    const p=checkedPath(String(path));
    if (!this.#dirs.has(p)) {
      if (this.#files.has(p)) fail('E_FS_NOT_DIR');
      fail('E_FS_NOT_FOUND');
    }
    for (const [name,bytes] of this.#files) {
      if (name.startsWith(p+'/')) {
        this.#files.delete(name); this.#fileBytes-=bytes.length;
      }
    }
    for (const dir of [...this.#dirs]) {
      if (dir===p || dir.startsWith(p+'/')) this.#dirs.delete(dir);
    }
    this.#invalidateHandles(p);
  }
  async metadata(token,path) {
    this.#actor(token,'read');
    const p=checkedDirectoryPath(String(path));
    if (this.#dirs.has(p)) return Object.freeze({is_file:false,is_dir:true,size:0});
    const bytes=this.#file(p);
    return Object.freeze({is_file:true,is_dir:false,size:bytes.length});
  }
  async exists(token,path) {
    this.#actor(token,'read');
    const p=checkedDirectoryPath(String(path));
    return this.#dirs.has(p) || this.#files.has(p);
  }
  async is_file(token,path) {
    this.#actor(token,'read');
    return this.#files.has(checkedDirectoryPath(String(path)));
  }
  async is_dir(token,path) {
    this.#actor(token,'read');
    return this.#dirs.has(checkedDirectoryPath(String(path)));
  }
  async file_size(token,path) {
    this.#actor(token,'read');
    return this.#file(checkedPath(String(path))).byteLength;
  }
  #entry(token,handle,permission) {
    const actor=this.#actor(token,permission);
    const entry=this.#handles.get(handle);
    if (!entry || entry.closed) fail('E_FS_CLOSED');
    if (entry.actor!==actor) fail('E_FS_HANDLE');
    if (permission==='read' && !entry.read) fail('E_IO_PERMISSION');
    if (permission==='write' && !entry.write) fail('E_IO_PERMISSION');
    return entry;
  }
  #fileObjectHandle(token,value,permission) {
    const handle=this.#fileObjects.get(value);
    if (!handle) fail('E_FS_HANDLE');
    this.#entry(token,handle,permission); // authenticate actor incarnation + mode
    return handle;
  }
  #readRemainingHandle(token,handle) {
    const entry=this.#entry(token,handle,'read');
    const bytes=this.#file(entry.path);
    if (entry.offset>bytes.length) fail('E_FS_OFFSET');
    const result=new Uint8Array(bytes.subarray(entry.offset));
    entry.offset=bytes.length; // EOF cursor; same File remains open
    return result;
  }
  #writeEntireHandle(token,handle,input) {
    const entry=this.#entry(token,handle,'write');
    if (!(input instanceof Uint8Array)) fail('E_FS_BYTES');
    if (input.length>this.#maxFileBytes) fail('E_FS_LIMIT');
    // Preflight the full write for this memory-only backend: avoid a partial
    // mutation on a known file/tenant quota failure.
    const current=this.#file(entry.path);
    const at=entry.append ? current.length : entry.offset;
    if (at>current.length || input.length>this.#maxFileBytes-at) fail('E_FS_LIMIT');
    const after=Math.max(current.length,at+input.length);
    if (after>this.#maxTotalBytes-(this.#fileBytes-current.length)) fail('E_FS_LIMIT');
    let written=0;
    while (written<input.length) {
      const part=input.subarray(written,Math.min(written+65536,input.length));
      const count=this.#writeHandle(token,handle,part);
      if (count<=0 || count>part.length) fail('E_FS_IO');
      written+=count;
    }
  }
  #seekHandle(token,handle,offset) {
    const entry=this.#entry(token,handle,null);
    if (!boundedInteger(offset,0,this.#maxFileBytes) ||
        offset>this.#file(entry.path).length) fail('E_FS_OFFSET');
    entry.offset=offset;
    return offset;
  }
  #readHandle(token,handle,maxBytes) {
    const entry=this.#entry(token,handle,'read');
    if (!boundedInteger(maxBytes,0,65536)) fail('E_FS_LIMIT');
    const bytes=this.#file(entry.path);
    if (entry.offset>bytes.length) fail('E_FS_OFFSET');
    const end=Math.min(bytes.length,entry.offset+maxBytes);
    const part=new Uint8Array(bytes.subarray(entry.offset,end));
    entry.offset=end;
    return part;
  }
  #writeHandle(token,handle,data) {
    const entry=this.#entry(token,handle,'write');
    if (!(data instanceof Uint8Array)) fail('E_FS_BYTES');
    const bytes=new Uint8Array(data);
    if (bytes.length===0) return 0;
    if (bytes.length>65536) fail('E_FS_LIMIT');
    const old=this.#file(entry.path), at=entry.append ? old.length : entry.offset;
    if (at>old.length || bytes.length>this.#maxFileBytes-at) fail('E_FS_LIMIT');
    const next=new Uint8Array(Math.max(old.length,at+bytes.length));
    next.set(old); next.set(bytes,at);
    this.#storeFile(entry.path,next);
    entry.offset=at+bytes.length;
    return bytes.length;
  }
  #closeHandle(token,handle) {
    this.#actor(token,null);
    const entry=this.#handles.get(handle);
    if (!entry) return; // same owner may close again: idempotent.
    if (entry.actor!==this.#actor(token,null)) fail('E_FS_HANDLE');
    entry.closed=true; this.#handles.delete(handle);
  }
  async open(token,path,options={}) {
    const actor=this.#actor(token,null), p=checkedPath(String(path));
    if (!options || typeof options!=='object' || Array.isArray(options)) fail('E_FS_OPTIONS');
    const validKeys=new Set(['read','write','append','create','create_new','truncate']);
    if (Object.keys(options).some(key=>!validKeys.has(key))) fail('E_FS_OPTIONS');
    const {read=false,write=false,append=false,create=false,create_new=false,
      truncate=false}=options;
    if ([read,write,append,create,create_new,truncate].some(x=>typeof x!=='boolean') ||
        (!read && !write && !append) ||
        (truncate && (!write || append)) ||
        ((create || create_new) && !(write || append)) ||
        (create_new && truncate)) fail('E_FS_OPTIONS');
    if (read) this.#actor(token,'read');
    if (write || append) this.#actor(token,'write');
    if (this.#handles.size>=this.#maxHandles) fail('E_FS_LIMIT');
    if (this.#dirs.has(p)) fail('E_FS_NOT_FILE');
    const old=this.#files.get(p);
    if (old && create_new) fail('E_FS_EXISTS');
    if (!old && !(create || create_new)) fail('E_FS_NOT_FOUND');
    if (!old || truncate) this.#storeFile(p,new Uint8Array());
    const handle=Object.freeze({});
    this.#handles.set(handle,{actor,path:p,read,write:write||append,append,
      offset:append?this.#file(p).length:0,closed:false});
    const file=Object.freeze({
      read: async maxBytes=>this.#readHandle(token,handle,maxBytes),
      write: async bytes=>this.#writeHandle(token,handle,bytes),
      seek: async offset=>this.#seekHandle(token,handle,offset),
      flush: async ()=>{ this.#entry(token,handle,null); },
      close: async ()=>this.#closeHandle(token,handle)
    });
    this.#fileObjects.set(file,handle);
    return file;
  }
  async read_stream(token,path,chunkBytes=65536) {
    if (!boundedInteger(chunkBytes,1,65536)) fail('E_FS_LIMIT');
    const file=await this.open(token,path,{read:true});
    let busy=false;
    const exclusive=async fn=>{
      if (busy) fail('E_FS_BUSY');
      busy=true;
      try { return await fn(); } finally { busy=false; }
    };
    return Object.freeze({
      read_chunk: ()=>exclusive(async()=>{
        const bytes=await file.read(chunkBytes);
        return bytes.length ? bytes : null;
      }),
      close: ()=>exclusive(()=>file.close())
    });
  }
  async write_stream(token,path,options={write:true,create:true,truncate:true}) {
    if (!options || (options.write!==true && options.append!==true)) fail('E_FS_OPTIONS');
    const file=await this.open(token,path,options);
    let busy=false;
    const exclusive=async fn=>{
      if (busy) fail('E_FS_BUSY');
      busy=true;
      try { return await fn(); } finally { busy=false; }
    };
    return Object.freeze({
      write_chunk: bytes=>exclusive(async()=>{
        if (!(bytes instanceof Uint8Array)) fail('E_FS_BYTES');
        // VFS writes are all-or-error. Native adapters must loop and check
        // partial progress under a single per-stream outstanding operation.
        const written=await file.write(bytes);
        if (written!==bytes.length) fail('E_FS_IO');
      }),
      flush: ()=>exclusive(()=>file.flush()),
      close: ()=>exclusive(()=>file.close())
    });
  }

  async request_bytes(token, input) {
    const actor = this.#actor(token, 'network');
    // This profile intentionally permits only explicitly granted loopback origins.
    const url = allowedUrl(input, this.#allowedOrigins, true);
    if (this.#live.size >= this.#maxInflight) fail('E_NET_BUSY');
    const abort = new AbortController();
    let finished = false;
    let timer;
    let rejectRace;
    const early = new Promise((_, reject) => { rejectRace = reject; });
    const job = {actor, reject(error) {
      if (finished) return;
      abort.abort();
      rejectRace(error);
    }};
    this.#live.add(job);
    timer = setTimeout(() => job.reject(new HostIoError('E_IO_TIMEOUT')), this.#timeoutMs);
    const fetchAndRead = async () => {
      let response;
      try {
        response = await this.#fetch(url.href, {
          method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer',
          redirect: 'manual', signal: abort.signal
        });
      } catch { fail('E_NET_TRANSPORT'); }
      let receivedOrigin;
      try { receivedOrigin = new URL(response?.url).origin; } catch { fail('E_NET_RESPONSE'); }
      if (!response || !Number.isSafeInteger(response.status) ||
          response.status < 200 || response.status > 599 ||
          receivedOrigin !== url.origin ||
          response.type === 'opaque' || response.type === 'opaqueredirect' ||
          (response.status >= 300 && response.status < 400)) fail('E_NET_RESPONSE');
      if (!response.body && [204, 205].includes(response.status))
        return Object.freeze({status: response.status, body: new Uint8Array()});
      if (!response.body || typeof response.body.getReader !== 'function') fail('E_NET_BODY');
      const chunks = [];
      let size = 0;
      let reader;
      try { reader = response.body.getReader(); } catch { fail('E_NET_BODY'); }
      try {
        while (true) {
          let part;
          try { part = await reader.read(); } catch { fail('E_NET_TRANSPORT'); }
          const {done, value} = part;
          if (done) break;
          if (!(value instanceof Uint8Array) || value.byteLength > this.#maxBodyBytes - size)
            fail('E_NET_LIMIT');
          size += value.byteLength;
          chunks.push(new Uint8Array(value));
        }
      } finally {
        try { reader.releaseLock(); } catch { /* Abort may have retired reader. */ }
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return Object.freeze({status: response.status, body: bytes});
    };
    // Keep the physical slot until the host transport actually unwinds.
    // Aborted transports that ignore signals must not defeat the concurrency cap.
    const physical = fetchAndRead();
    void physical.then(() => this.#live.delete(job), () => this.#live.delete(job));
    try {
      const result = await Promise.race([physical, early]);
      if (this.#closed || !actor.active) fail('E_IO_CANCELLED');
      return result;
    } finally {
      finished = true;
      clearTimeout(timer);
      abort.abort();
    }
  }

  async request_text(token, url) {
    const {status, body} = await this.request_bytes(token, url);
    try { return Object.freeze({status, text: textDecoder.decode(body)}); }
    catch { fail('E_INVALID_UTF8'); }
  }
}
