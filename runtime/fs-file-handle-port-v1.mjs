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
    const file=this.#handles.get(id);
    if (!file) fsFail('E_FS_CLOSED');
    return file;
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
        if (this.#closed) {
          try { await file.close(); } catch { /* actor may be revoked */ }
          fsFail('E_FS_CLOSED');
        }
        this.#issued.add(id);
        this.#handles.set(id,file);
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

  async read(id,maxBytes) { return this.#lookup(id).read(maxBytes); }
  async write(id,bytes) { return this.#lookup(id).write(bytes); }
  async seek(id,offset) { return this.#lookup(id).seek(offset); }
  async flush(id) { return this.#lookup(id).flush(); }

  // These helpers accept only a host-owned File obtained from #lookup.
  // They do not return File closures or actor tokens into guest memory.
  async read_text(id) {
    return this.#vfs.read_text(this.#actorTicket,this.#lookup(id));
  }
  async write_text(id,text) {
    return this.#vfs.write_text(this.#actorTicket,this.#lookup(id),text);
  }
  async read_file(id) {
    return this.#vfs.read_file(this.#actorTicket,this.#lookup(id));
  }
  async write_file(id,bytes) {
    return this.#vfs.write_file(this.#actorTicket,this.#lookup(id),bytes);
  }

  async close(id) {
    const file=this.#lookup(id);
    // Retire the guest-visible handle BEFORE invoking the host close,
    // including when the actor was revoked and close throws.
    this.#handles.delete(id);
    await file.close();
  }

  async close_all() {
    if (this.#closed) return;
    this.#closed = true;
    const retired=[...this.#handles.values()];
    this.#handles.clear();
    // Pending opens will see #closed after their await and retire
    // themselves; never leak a late-created host File.
    await Promise.allSettled([
      ...retired.map(file=>file.close()),
      ...this.#pendingOpens
    ]);
  }
}
