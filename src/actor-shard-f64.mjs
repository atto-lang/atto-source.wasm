import {ActorArena} from "./actor-arena.mjs";

// Host-only f64 layout substrate over actor-owned WebAssembly.Memory.
// No live WebAssembly.Memory view, raw pointer, or arena handle is exposed.
const nativeSafeInteger = Number.isSafeInteger;
const nativeFinite = Number.isFinite;
const nativeIsArray = Array.isArray;
const nativeOwnDescriptor = Object.getOwnPropertyDescriptor;
const NativeArrayBuffer = ArrayBuffer;
const NativeUint8Array = Uint8Array;
const NativeUint32Array = Uint32Array;
const NativeDataView = DataView;
const dataViewGetFloat64 = NativeDataView.prototype.getFloat64;
const dataViewSetFloat64 = NativeDataView.prototype.setFloat64;
const layouts = new Set(["aos", "soa", "aosoa", "soaos"]);
const setHas = Set.prototype.has;

// Capture arena entry points before unrelated userland can replace prototypes.
const arenaAllocPersistent = ActorArena.prototype.allocPersistent;
const arenaDropPersistent = ActorArena.prototype.dropPersistent;
const arenaReadRangeInto = ActorArena.prototype.readRangeInto;
const arenaWriteRange = ActorArena.prototype.writeRange;

const SCALAR_BYTES = 8;
export const MAX_ACTOR_SHARD_BYTES = 65536;
const MAX_SCALARS = MAX_ACTOR_SHARD_BYTES / SCALAR_BYTES;
const MAX_AOSOA_LANES = 1024;

function requirePositiveInteger(value, label) {
  if (!nativeSafeInteger(value) || value <= 0) {
    throw new RangeError(`invalid ${label}`);
  }
}

function snapshotGroups(groupWidths, fields) {
  if (!nativeIsArray(groupWidths) || groupWidths.length === 0 ||
      groupWidths.length > fields) {
    throw new TypeError("SoAoS requires bounded nonempty field groups");
  }
  const copy = new NativeUint32Array(groupWidths.length);
  let total = 0;
  for (let i = 0; i < groupWidths.length; ++i) {
    const descriptor = nativeOwnDescriptor(groupWidths, String(i));
    if (!descriptor || !Object.hasOwn(descriptor, "value") ||
        !nativeSafeInteger(descriptor.value) || descriptor.value <= 0) {
      throw new TypeError("SoAoS group widths must be own positive integers");
    }
    total += descriptor.value;
    if (total > fields) throw new RangeError("SoAoS groups exceed field count");
    copy[i] = descriptor.value;
  }
  if (total !== fields) throw new RangeError("SoAoS groups must partition every field");
  return copy;
}

export class ActorShardF64 {
  #arena;
  #storage;
  #released = false;
  #groupBase = null;
  #fieldOffset = null;
  #groupWidth = null;
  #cellBuffer = new NativeArrayBuffer(SCALAR_BYTES);
  #cellBytes = new NativeUint8Array(this.#cellBuffer);
  #cellView = new NativeDataView(this.#cellBuffer);

  constructor(arena, turn, {
    rows, fields, layout, lanes = 1, groupWidths = null
  } = {}) {
    requirePositiveInteger(rows, "rows");
    requirePositiveInteger(fields, "fields");
    if (!setHas.call(layouts, layout)) throw new RangeError("unknown actor shard layout");

    // Physical storage is one persistent actor allocation and must fit within
    // the current wasm32 actor persistent page.
    if (rows > MAX_SCALARS / fields) {
      throw new RangeError("actor shard exceeds 64 KiB persistent page");
    }

    if (layout === "aosoa") {
      if (!nativeSafeInteger(lanes) || lanes <= 0 || lanes > MAX_AOSOA_LANES ||
          (lanes & (lanes - 1)) !== 0) {
        throw new RangeError("AoSoA lanes must be a power of two in [1,1024]");
      }
    } else if (lanes !== 1) {
      throw new RangeError("AoS, SoA, and SoAoS use lane width one");
    }

    const physicalRows = layout === "aosoa"
      ? rows + ((lanes - (rows & (lanes - 1))) & (lanes - 1))
      : rows;
    if (physicalRows > MAX_SCALARS / fields) {
      throw new RangeError("AoSoA padding exceeds 64 KiB actor shard");
    }

    let groups = null;
    if (layout === "soaos") {
      groups = snapshotGroups(groupWidths, fields);
    } else if (groupWidths !== null) {
      throw new TypeError("SoAoS group metadata is invalid for this layout");
    }

    this.rows = rows;
    this.fields = fields;
    this.layout = layout;
    this.lanes = lanes;
    this.physicalRows = physicalRows;
    this.byteLength = physicalRows * fields * SCALAR_BYTES;
    this.groupCount = groups?.length ?? 0;

    if (groups) {
      this.#groupBase = new NativeUint32Array(fields);
      this.#fieldOffset = new NativeUint32Array(fields);
      this.#groupWidth = new NativeUint32Array(fields);
      let field = 0;
      let base = 0;
      for (let group = 0; group < groups.length; ++group) {
        const width = groups[group];
        for (let within = 0; within < width; ++within) {
          this.#groupBase[field] = base;
          this.#fieldOffset[field] = within;
          this.#groupWidth[field] = width;
          ++field;
        }
        base += rows * width;
      }
    }

    this.#arena = arena;
    this.#storage = arenaAllocPersistent.call(arena, turn, this.byteLength);
  }

  #live() {
    if (this.#released) throw new Error("actor shard released");
  }

  getPhysicalByteOffset(row, field) {
    this.#live();
    if (!nativeSafeInteger(row) || row < 0 || row >= this.rows ||
        !nativeSafeInteger(field) || field < 0 || field >= this.fields) {
      throw new RangeError("actor shard row/field out of bounds");
    }

    let scalar;
    switch (this.layout) {
      case "aos":
        scalar = row * this.fields + field;
        break;
      case "soa":
        scalar = field * this.rows + row;
        break;
      case "aosoa":
        scalar = (((Math.trunc(row / this.lanes) * this.fields + field) *
          this.lanes) + (row % this.lanes));
        break;
      case "soaos":
        scalar = this.#groupBase[field] +
          row * this.#groupWidth[field] + this.#fieldOffset[field];
        break;
      default:
        throw new Error("unknown actor shard layout");
    }
    return scalar * SCALAR_BYTES;
  }

  read(turn, row, field) {
    const offset = this.getPhysicalByteOffset(row, field);
    arenaReadRangeInto.call(this.#arena, turn, this.#storage, offset, this.#cellBytes);
    return dataViewGetFloat64.call(this.#cellView, 0, true);
  }

  write(turn, row, field, value) {
    if (typeof value !== "number") throw new TypeError("actor shard value must be f64");
    const offset = this.getPhysicalByteOffset(row, field);
    dataViewSetFloat64.call(this.#cellView, 0, value, true);
    arenaWriteRange.call(this.#arena, turn, this.#storage, offset, this.#cellBytes);
  }

  integrate(turn, positionField, velocityField, dt) {
    this.#live();
    if (!nativeSafeInteger(positionField) || !nativeSafeInteger(velocityField) ||
        positionField < 0 || positionField >= this.fields ||
        velocityField < 0 || velocityField >= this.fields ||
        positionField === velocityField) {
      throw new RangeError("integrate requires two distinct valid fields");
    }
    if (!nativeFinite(dt)) throw new RangeError("integrate dt must be finite");
    for (let row = 0; row < this.rows; ++row) {
      const position = this.read(turn, row, positionField);
      const velocity = this.read(turn, row, velocityField);
      this.write(turn, row, positionField, position + velocity * dt);
    }
  }

  release(turn) {
    if (this.#released) return;
    arenaDropPersistent.call(this.#arena, turn, this.#storage);
    this.#released = true;
  }
}
