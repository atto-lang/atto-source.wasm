// Host-only Atto/Wasm I/O adapter. NOT linked to guest imports or an Atto compiler.
// Provides explicitly granted loopback HTTP and tenant-private VFS for development.
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', {fatal: true});

export class HostIoError extends Error {
  constructor(code) { super(code); this.name = 'HostIoError'; this.code = code; }
}
function fail(code) { throw new HostIoError(code); }
const boundedInteger = (value, min, max) =>
  Number.isSafeInteger(value) && value >= min && value <= max;

function checkedPath(path) {
  if (typeof path !== 'string' || textEncoder.encode(path).length > 256 || path.length < 1 ||
      path.includes('\\') || path.includes('\0') || path.startsWith('/') || path.includes(':') ||
      !path.isWellFormed()) fail('E_FS_PATH');
  const p = path.startsWith('./') ? path.slice(2) : path;
  const parts = p.split('/');
  if (parts.some(s => !s || s === '.' || s === '..')) fail('E_FS_PATH');
  return parts.join('/');
}

function allowedUrl(input, origins, loopbackOnly) {
  if (typeof input !== 'string' || !input || textEncoder.encode(input).length > 2048 ||
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
  #actors = new Map();
  #files = new Map();
  #live = new Set();
  #fileBytes = 0;
  #closed = false;
  #allowedOrigins;
  #fetch;
  #maxBodyBytes;
  #maxFileBytes;
  #maxTotalBytes;
  #maxFiles;
  #maxInflight;
  #maxActors;
  #timeoutMs;

  constructor({tenantId, allowedOrigins = [], fetchImpl = globalThis.fetch,
    maxBodyBytes = 1024 * 1024, maxFileBytes = 1024 * 1024,
    maxTotalBytes = 4 * 1024 * 1024, maxFiles = 32,
    maxInflight = 8, maxActors = 128, timeoutMs = 30000} = {}) {
    if (typeof tenantId !== 'string' || !tenantId || tenantId.length > 128 ||
        !Array.isArray(allowedOrigins) || allowedOrigins.length > 32 ||
        typeof fetchImpl !== 'function' ||
        !boundedInteger(maxBodyBytes, 1, 16 * 1024 * 1024) ||
        !boundedInteger(maxFileBytes, 1, 16 * 1024 * 1024) ||
        !boundedInteger(maxTotalBytes, 1, 64 * 1024 * 1024) ||
        !boundedInteger(maxFiles, 1, 1024) ||
        !boundedInteger(maxInflight, 1, 64) ||
        !boundedInteger(maxActors, 1, 4096) ||
        !boundedInteger(timeoutMs, 1, 120000)) fail('E_IO_CONFIG');
    this.#tenantId = tenantId;
    this.#maxBodyBytes = maxBodyBytes;
    this.#maxFileBytes = maxFileBytes;
    this.#maxTotalBytes = maxTotalBytes;
    this.#maxFiles = maxFiles;
    this.#maxInflight = maxInflight;
    this.#maxActors = maxActors;
    this.#timeoutMs = timeoutMs;
    this.#fetch = fetchImpl;
    this.#allowedOrigins = new Set();
    for (const origin of allowedOrigins) {
      if (typeof origin !== 'string') fail('E_IO_CONFIG');
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
  get byte_count() { return this.#fileBytes; }

  open_actor(actorId, generation, {read = false, write = false, network = false} = {}) {
    if (this.#closed) fail('E_IO_CLOSED');
    if (!boundedInteger(actorId, 1, Number.MAX_SAFE_INTEGER) ||
        !boundedInteger(generation, 1, Number.MAX_SAFE_INTEGER) ||
        [read, write, network].some(v => typeof v !== 'boolean')) fail('E_IO_CONFIG');
    const previous = this.#actors.get(actorId);
    if (previous && generation <= previous.generation) fail('E_IO_STALE');
    if (!previous && this.#actors.size >= this.#maxActors) fail('E_IO_BUSY');
    if (previous) this.#revoke(previous);
    const token = Object.freeze({});
    this.#actors.set(actorId, {generation, token, read, write, network, active: true});
    return token;
  }

  #actor(token, permission) {
    if (this.#closed) fail('E_IO_CLOSED');
    for (const actor of this.#actors.values()) {
      if (actor.active && actor.token === token) {
        if (!actor[permission]) fail('E_IO_PERMISSION');
        return actor;
      }
    }
    fail('E_IO_STALE');
  }
  #revoke(actor) {
    actor.active = false;
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
    this.#actors.delete(actorId);
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const actor of this.#actors.values()) this.#revoke(actor);
    this.#actors.clear();
    this.#files.clear();
    this.#fileBytes = 0;
  }

  async write_text(token, path, text) {
    this.#actor(token, 'write');
    const p = checkedPath(path);
    if (typeof text !== 'string' || !text.isWellFormed()) fail('E_INVALID_UTF8');
    const bytes = textEncoder.encode(text);
    if (bytes.byteLength > this.#maxFileBytes) fail('E_FS_LIMIT');
    const previous = this.#files.get(p);
    if (!previous && this.#files.size >= this.#maxFiles) fail('E_FS_LIMIT');
    const nextTotal = this.#fileBytes - (previous?.byteLength ?? 0) + bytes.byteLength;
    if (nextTotal > this.#maxTotalBytes) fail('E_FS_LIMIT');
    // In-memory VFS commit is synchronous and atomic with respect to other JS turns.
    // No OS file or ambient directory is involved.
    this.#files.set(p, new Uint8Array(bytes));
    this.#fileBytes = nextTotal;
  }
  async read_text(token, path) {
    this.#actor(token, 'read');
    const bytes = this.#files.get(checkedPath(path));
    if (!bytes) fail('E_FS_NOT_FOUND');
    try { return textDecoder.decode(bytes); } catch { fail('E_INVALID_UTF8'); }
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
      const reader = response.body.getReader();
      try {
        while (true) {
          const {done, value} = await reader.read();
          if (done) break;
          if (!(value instanceof Uint8Array) || value.byteLength > this.#maxBodyBytes - size)
            fail('E_NET_LIMIT');
          size += value.byteLength;
          chunks.push(new Uint8Array(value));
        }
      } finally { reader.releaseLock(); }
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
