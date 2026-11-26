// Bounded experimental .atto -> real WebAssembly guest lowering for std.buffer
// surface syntax. NO host byte operations. Does not parse/link the canonical
// stdlib class; not general ByteBuffer compiler parity or TenantVM isolation.
const SOURCE_MAX = 16 * 1024;
const TOKENS_MAX = 512;
const BUFFER_MAX = 4096;
const INT_MAX = (1n << 63n) - 1n;

export class ByteBufferGuestError extends Error {
  constructor(code, message, offset = 0) {
    super(code + ': ' + message);
    this.name = 'ByteBufferGuestError';
    this.code = code;
    this.offset = offset;
  }
}
const fault = (code, message, offset) => { throw new ByteBufferGuestError(code, message, offset); };
const wordStart = c => /[a-zA-Z_]/.test(c);
const wordPart = c => /[a-zA-Z0-9_]/.test(c);
const digit = c => /[0-9]/.test(c);

function tokenize(source) {
  if (typeof source !== 'string' || new TextEncoder().encode(source).byteLength > SOURCE_MAX) {
    fault('E_BUFFER_SOURCE_LIMIT', 'source exceeds bounded profile');
  }
  const tokens = [];
  let at = 0;
  const emit = (kind, value, offset) => {
    if (tokens.length >= TOKENS_MAX) fault('E_BUFFER_SOURCE_LIMIT', 'too many tokens', offset);
    tokens.push({kind, value, offset});
  };
  while (at < source.length) {
    const c = source[at];
    if (/[ \n\t\r]/.test(c)) { ++at; continue; }
    if (source.startsWith('//', at)) {
      at += 2;
      while (at < source.length && source[at] !== '\n') ++at;
      continue;
    }
    if (source.startsWith('/*', at)) {
      const opening = at;
      at += 2;
      const end = source.indexOf('*/', at);
      if (end === -1) fault('E_BUFFER_SYNTAX', 'unterminated block comment', opening);
      at = end + 2;
      continue;
    }
    if (wordStart(c)) {
      const begin = at++;
      while (at < source.length && wordPart(source[at])) ++at;
      emit('word', source.slice(begin, at), begin);
      continue;
    }
    if (digit(c)) {
      const begin = at;
      if (source.startsWith('0x', at) || source.startsWith('0X', at)) {
        at += 2;
        const start = at;
        while (at < source.length && /[0-9a-fA-F]/.test(source[at])) ++at;
        if (at === start) fault('E_BUFFER_SYNTAX', 'hex literal requires digits', begin);
        emit('number', source.slice(begin, at), begin);
      } else {
        ++at;
        while (at < source.length && digit(source[at])) ++at;
        emit('number', source.slice(begin, at), begin);
      }
      continue;
    }
    if (c === '"') {
      const begin = at++;
      const start = at;
      while (at < source.length && source[at] !== '"' && source[at] !== '\n' && source[at] !== '\\') ++at;
      if (at === source.length || source[at] !== '"') fault('E_BUFFER_SYNTAX', 'bad string literal', begin);
      emit('string', source.slice(start, at), begin);
      ++at;
      continue;
    }
    if ('{}().,;:?=-'.includes(c)) { emit(c, c, at++); continue; }
    fault('E_BUFFER_SYNTAX', 'unsupported source token', at);
  }
  emit('eof', '', at);
  return tokens;
}

class Parser {
  constructor(source) { this.ts = tokenize(source); this.at = 0; this.locals = new Map(); this.writes = []; }
  get cur() { return this.ts[this.at]; }
  take(value) { const t = this.cur; if ((t.kind === 'word' || t.kind === value) && t.value === value) { ++this.at; return true; } return false; }
  expect(value) { if (!this.take(value)) fault('E_BUFFER_SYNTAX', 'expected ' + value, this.cur.offset); }
  word() {
    const t = this.cur;
    if (t.kind !== 'word') fault('E_BUFFER_SYNTAX', 'identifier required', t.offset);
    ++this.at;
    return t.value;
  }
  unique(name) {
    if (this.locals.has(name)) fault('E_BUFFER_DUPLICATE', 'duplicate local', this.cur.offset);
  }
  integer() {
    const negative = this.take('-');
    const t = this.cur;
    if (t.kind !== 'number') fault('E_BUFFER_SYNTAX', 'integer literal required', t.offset);
    ++this.at;
    const parsed = BigInt(t.value) * (negative ? -1n : 1n);
    if (parsed < -INT_MAX - 1n || parsed > INT_MAX) fault('E_BUFFER_VALUE', 'i64 literal out of range', t.offset);
    return parsed;
  }
  method() {
    this.expect('.');
    const op = this.word();
    const match = /^(read|write)_u(8|16|32)(?:_(le|be))?$/.exec(op);
    if (!match || ((match[2] === '8') !== (match[3] === undefined))) {
      fault('E_BUFFER_UNSUPPORTED', 'unsupported byte method', this.cur.offset);
    }
    return {op: match[1], width: Number(match[2]) / 8, endian: match[3] ?? 'le'};
  }
  checkedIndex(index, width, length) {
    if (index < 0n || BigInt(width) > length || index > length - BigInt(width)) {
      fault('E_BUFFER_BOUNDS', 'out-of-bounds byte range', this.cur.offset);
    }
    return Number(index);
  }
  readValue() {
    if (this.cur.kind === 'number' || this.cur.value === '-') return {kind:'int', value:this.integer()};
    const name = this.word();
    if (name === this.buffer && this.cur.value === '.') {
      const method = this.method();
      if (method.op !== 'read') fault('E_BUFFER_UNSUPPORTED', 'writes are statements', this.cur.offset);
      this.expect('(');
      const index = this.checkedIndex(this.integer(), method.width, this.length);
      this.expect(')');
      return {kind:'read', index, width:method.width, endian:method.endian};
    }
    const local = this.locals.get(name);
    if (!local || local.kind !== 'value') fault('E_BUFFER_UNKNOWN', 'unknown scalar local', this.cur.offset);
    return {kind:'local', slot:local.slot};
  }
  run() {
    this.expect('import'); this.expect('module');
    this.alias = this.word();
    this.expect('from'); this.expect('pkg');
    if (this.cur.kind !== 'string' || this.cur.value !== 'std.buffer') {
      fault('E_BUFFER_MODULE', 'only std.buffer import admitted', this.cur.offset);
    }
    ++this.at;
    this.expect(';'); this.expect('pub'); this.expect('fnc'); this.expect('main');
    this.expect('('); this.expect(')'); this.expect(':'); this.expect('int');
    this.expect('throws'); this.expect('Error'); this.expect('{');
    const binding = this.word();
    if (binding !== 'val' && binding !== 'let') fault('E_BUFFER_SYNTAX','buffer binding required', this.cur.offset);
    this.mutable = this.take('mut');
    this.buffer = this.word();
    this.unique(this.buffer);
    this.expect('='); this.expect(this.alias); this.expect('.'); this.expect('ByteBuffer');
    this.expect('.'); this.expect('allocate'); this.expect('(');
    this.length = this.integer();
    this.expect(')'); this.expect(';');
    if (this.length < 0n || this.length > BigInt(BUFFER_MAX)) {
      fault('E_BUFFER_ALLOCATION', 'bounded guest region allocation rejected', this.cur.offset);
    }
    this.locals.set(this.buffer,{kind:'buffer'});
    let nextLocal = 0;
    while (this.cur.kind !== 'eof' && this.cur.value !== 'return') {
      if (this.cur.value === 'val' || this.cur.value === 'let') {
        ++this.at;
        // Only immutable scalar locals are admitted here.
        this.expect('int');
        const id = this.word();
        this.unique(id);
        this.expect('=');
        const value = this.readValue();
        this.expect(';');
        const slot = nextLocal++;
        this.locals.set(id,{kind:'value',slot});
        this.writes.push({kind:'store_local',value,slot});
      } else {
        this.expect(this.buffer);
        const method = this.method();
        if (method.op !== 'write') fault('E_BUFFER_UNSUPPORTED', 'read must be used as expression', this.cur.offset);
        if (!this.mutable) fault('E_IMMUTABLE', 'mutating val requires mut', this.cur.offset);
        this.expect('(');
        const index = this.checkedIndex(this.integer(), method.width, this.length);
        this.expect(',');
        const value = this.integer();
        this.expect(')'); this.expect(';');
        if (value < 0n || value > ((1n << BigInt(8*method.width)) - 1n)) {
          fault('E_BUFFER_VALUE', 'unsigned value out of range', this.cur.offset);
        }
        this.writes.push({kind:'write',index,width:method.width,endian:method.endian,value});
      }
    }
    this.expect('return');
    const first = this.readValue();
    let result = {kind:'return',first};
    if (this.take('eq')) {
      const second = this.readValue();
      this.expect('?'); const yes = this.integer();
      this.expect(':'); const no = this.integer();
      result = {kind:'ternary', first, second, yes, no};
    }
    this.expect(';'); this.expect('}');
    if (this.cur.kind !== 'eof') fault('E_BUFFER_SYNTAX', 'trailing top-level data', this.cur.offset);
    return {length:Number(this.length),locals:nextLocal,body:this.writes,result};
  }
}

function uleb(num) {
  const b=[];
  while (true) {
    const piece=num & 0x7f;
    num=Math.floor(num/128);
    b.push(piece|(num===0?0:0x80));
    if (num===0)break;
  }
  return b;
}
function sleb(num) {
  let n=BigInt(num),out=[];
  do {
    const byte=Number(n & 127n);
    n >>= 7n;
    const done=(n===0n && !(byte&64))||(n===-1n && !!(byte&64));
    out.push(done ? byte : byte|128);
    if(done)break;
  } while(true);
  return out;
}
const utf8=s=>Array.from(new TextEncoder().encode(s));
function section(id,bytes){return [id,...uleb(bytes.length),...bytes];}
function emit(plan) {
  const code=[];
  const op=(...bytes)=>code.push(...bytes);
  const i32c=value=>op(0x41,...sleb(value));
  const i64c=value=>op(0x42,...sleb(value));
  const value=e=>{
    switch(e.kind){
      case 'int': i64c(e.value); break;
      case 'local': op(0x20,...uleb(e.slot)); break;
      case 'read': {
        for (let i=0;i<e.width;i++){
          i32c(e.index+i);
          op(0x2d,0,0); // i32.load8_u align0 offset0
          op(0xad); // i64.extend_i32_u
          const shift=8*(e.endian==='le'?i:e.width-1-i);
          if (shift>0){i64c(shift);op(0x86);} // i64.shl
          if(i>0)op(0x84); // i64.or, always unsigned widen
        }
        break;
      }
      default:throw new Error('internal invalid expression');
    }
  };
  for(const s of plan.body){
    if(s.kind==='store_local'){
      value(s.value);op(0x21,...uleb(s.slot)); // local.set
    }else{
      for(let i=0;i<s.width;i++){
        const shift=8*(s.endian==='le'?i:s.width-1-i);
        const byte=Number((s.value >> BigInt(shift)) & 255n);
        i32c(s.index+i);i32c(byte);op(0x3a,0,0); // i32.store8
      }
    }
  }
  if(plan.result.kind==='ternary'){
    value(plan.result.first);value(plan.result.second);op(0x51); // i64.eq
    op(0x04,0x7e); // if (result i64)
    i64c(plan.result.yes);op(0x05);i64c(plan.result.no);op(0x0b);
  }else value(plan.result.first);
  op(0x0b); // end function
  const locals=plan.locals>0 ? [1,...uleb(plan.locals),0x7e] : [0];
  const body=[...locals,...code];
  const types=section(1,[1,0x60,0,1,0x7e]); // () -> i64
  const funcs=section(3,[1,0]);
  const memory=section(5,[1,1,1,1]); // 1 memory, min=1 max=1 page
  const exportItem=(name,kind,index)=>[...uleb(utf8(name).length),...utf8(name),kind,...uleb(index)];
  const exports=section(7,[2,...exportItem('main',0,0),...exportItem('memory',2,0)]);
  const codeSection=section(10,[1,...uleb(body.length),...body]);
  return Uint8Array.from([0,97,115,109,1,0,0,0,...types,...funcs,...memory,...exports,...codeSection]);
}

// Compile an explicitly limited surface. This recognizes the std.buffer API,
// but does not resolve/compile canonical stdlib .atto class definitions.
// Emits a zero-host-import Wasm module with private, fixed-size memory.
export function compileByteBufferGuestV1(source) {
  const plan=new Parser(source).run();
  const wasm=emit(plan);
  if(wasm.byteLength>65536) fault('E_BUFFER_OUTPUT_LIMIT','guest exceeds bounded output');
  return wasm;
}
