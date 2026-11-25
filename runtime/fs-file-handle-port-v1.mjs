// Privileged host-only candidate for compiled std.fs File instance lowering.
// NOT a guest import, a guest-visible object or a native filesystem interface.
// The trusted actor dispatcher owns each instance and supplies its host-only
// actor ticket; untrusted guest code may supply only bounded numeric handles.
import {TenantHostedIoV1, FsError} from './hosted-io-v1.mjs';

export const FILE_HANDLE_PORT_ABI_V1 = Object.freeze({
  version: 1,
  boundary: 'trusted-host-actor-dispatch-only',
  handles: 'per-actor numeric indices; never reusable within one port',
  operations: Object.freeze([
    'open','read','write','read_file','write_file','read_text',
    'write_text','seek','flush','close'
  ]),
  guest_import_linked: false
});

function fsFail(code) { throw new FsError(code); }
const boundedInt = (n, min, max) =>
  Number.isSafeInteger(n) && n >= min && n <= max;

export class ActorFileHandlePortV1 {
  #vfs;
  #actorTicket;
  #handles = new Map();
  #issued = new Set(); // Only successfully issued IDs can become CLOSED.
  #pendingOpens = new Set(); // Await late opens on structured close_all.
  #inflight = new Set(); // Read/write/close operations tracked for shutdown.
  #closingPromise = null;
  #nextId = 1;
  #pending = 0;
  #maxOpen;
  #maxIssued;
  #closed = false;

  constructor(vfs, actorTicket, options = {}) {
    if (!options || typeof options!=='object' || Array.isArray(options) ||
        Object.keys(options).some(k=>k!=='maxOpen' && k!=='maxIssued'))
      fsFail('E_FS_OPTIONS');
    const {maxOpen = 64, maxIssued = 4096} = options;
    if (!(vfs instanceof TenantHostedIoV1) ||
        !actorTicket || typeof actorTicket !== 'object' ||
        !boundedInt(maxOpen,1,1024) ||
        !boundedInt(maxIssued,maxOpen,65536)) fsFail('E_FS_OPTIONS');
    this.#vfs = vfs;
    this.#actorTicket = actorTicket;
    this.#maxOpen = maxOpen;
    this.#maxIssued = maxIssued;
  }

  get open_handle_count() { return this.#handles.size; }
  get issued_handle_count() { return this.#nextId-1; }

  #requireOpen() { if (this.#closed) fsFail('E_FS_CLOSED'); }

  #lookup(id) {
    this.#requireOpen();
    if (!boundedInt(id,1,this.#maxIssued) || !this.#issued.has(id))
      fsFail('E_FS_HANDLE');
    const entry=this.#handles.get(id);
    if (!entry) fsFail('E_FS_CLOSED');
    return entry;
  }

  // Serializes every operation on a File, unlike accidentally allowing
  // overlapping operations on a bearer-like JS File method closure.
  #using(id, fn) {
    const entry=this.#lookup(id);
    if (entry.busy) fsFail('E_FS_BUSY');
    entry.busy=true;
    const operation=(async()=>{
      try {
        const result=await fn(entry.file);
        // Do not report success after port close OR actor incarnation
        // revoke/restart; guest and host time must agree on admission.
        this.#requireOpen();
        this.#vfs.assert_actor_active(this.#actorTicket);
        return result;
      } finally {
        entry.busy=false;
      }
    })();
    this.#inflight.add(operation);
    void operation.then(
      ()=>this.#inflight.delete(operation),
      ()=>this.#inflight.delete(operation)
    );
    return operation;
  }

  async open(path, options) {
    this.#requireOpen();
    // Reserve a slot BEFORE awaiting host completion, so concurrent opens
    // cannot exceed the port quota. Failed admission never returns an ID.
    if (this.#handles.size + this.#pending >= this.#maxOpen ||
        this.#nextId > this.#maxIssued) fsFail('E_FS_LIMIT');
    const id=this.#nextId++;
    this.#pending++;
    const operation=(async()=>{
      try {
        const file=await this.#vfs.open(this.#actorTicket,path,options);
        // Actor may have restarted while the asynchronous open completed.
        // Always retire its host object if current admission failed.
        try {
          this.#requireOpen();
          this.#vfs.assert_actor_active(this.#actorTicket);
        } catch (error) {
          try { await file.close(); } catch { /* already revoked */ }
          throw error;
        }
        this.#issued.add(id);
        this.#handles.set(id,{file,busy:false});
        return id;
      } finally {
        this.#pending--;
      }
    })();
    this.#pendingOpens.add(operation);
    // Cleanup on either completion path without creating unhandled rejections.
    void operation.then(
      ()=>this.#pendingOpens.delete(operation),
      ()=>this.#pendingOpens.delete(operation)
    );
    return operation;
  }

  async read(id,maxBytes) {
    return this.#using(id,file=>file.read(maxBytes));
  }
  async write(id,bytes) {
    return this.#using(id,file=>file.write(bytes));
  }
  async seek(id,offset) {
    return this.#using(id,file=>file.seek(offset));
  }
  async flush(id) {
    return this.#using(id,file=>file.flush());
  }

  // File values never cross this trusted host port boundary.
  async read_text(id) {
    return this.#using(id,file=>this.#vfs.read_text(this.#actorTicket,file));
  }
  async write_text(id,text) {
    return this.#using(id,file=>this.#vfs.write_text(this.#actorTicket,file,text));
  }
  async read_file(id) {
    return this.#using(id,file=>this.#vfs.read_file(this.#actorTicket,file));
  }
  async write_file(id,bytes) {
    return this.#using(id,file=>this.#vfs.write_file(this.#actorTicket,file,bytes));
  }

  async close(id) {
    this.#requireOpen();
    if (!boundedInt(id,1,this.#maxIssued) || !this.#issued.has(id))
      fsFail('E_FS_HANDLE');
    const entry=this.#handles.get(id);
    if (!entry) return; // Repeated close of issued, retired ID is idempotent.
    if (entry.busy) fsFail('E_FS_BUSY');
    entry.busy=true;
    this.#handles.delete(id);
    const operation=entry.file.close();
    this.#inflight.add(operation);
    try { await operation; }
    finally {
      entry.busy=false;
      this.#inflight.delete(operation);
    }
  }

  async close_all() {
    if (this.#closingPromise) return this.#closingPromise;
    this.#closed = true;
    // Do not close underlying file objects until outstanding operations
    // settle; those operations will reject late success as E_FS_CLOSED.
    this.#closingPromise=(async()=>{
      await Promise.allSettled([...this.#inflight]);
      const retired=[...this.#handles.values()].map(entry=>entry.file);
      this.#handles.clear();
      // Pending opens notice #closed and retire their own File objects.
      await Promise.allSettled([
        ...retired.map(file=>file.close()),
        ...this.#pendingOpens
      ]);
    })();
    return this.#closingPromise;
  }
}
