// Independent host-only BigInt oracle. No compiler-backed guest execution is implied.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const c=JSON.parse(readFileSync(new URL('../contracts/oresllm-parity/v1/scalar.json',import.meta.url),'utf8'));
const MIN=-(1n<<63n),MAX=(1n<<63n)-1n;
function checked(n){if(n<MIN||n>MAX)throw Error('signed 64 overflow');return n;}
function evaluate(expr){
  const tokens=expr.match(/\d+|[()+*-]|\S/g)||[];
  let at=0;
  function primary(){
    const t=tokens[at++];
    if(t===undefined)throw Error('unexpected end');
    if(t==='('){const n=add();if(tokens[at++]!==')')throw Error('missing )');return n;}
    if(t==='+'||t==='-'){
      if(t==='-'&&/^\d+$/.test(tokens[at]||'')&&BigInt(tokens[at])===MAX+1n){
        at++;return MIN;
      }
      const n=primary();return checked(t==='-'?-n:n);
    }
    if(!/^\d+$/.test(t))throw Error('unsupported token '+t);
    return checked(BigInt(t));
  }
  function mul(){let n=primary();while(tokens[at]==='*'){at++;n=checked(n*primary());}return n;}
  function add(){let n=mul();while(tokens[at]==='+'||tokens[at]==='-'){
    const op=tokens[at++],rhs=mul();n=checked(op==='+'?n+rhs:n-rhs);
  }return n;}
  const result=add();if(at!==tokens.length)throw Error('trailing token '+tokens[at]);return result;
}
function validate(input){
  assert.equal(input.schema_version,1);
  assert.equal(input.contract,'oresllm-scalar-i64-intersection-v1');
  assert.equal(input.classification,'candidate-parity-not-native-execution');
  assert.deepEqual(input.required_backends,['java','llvm','wasm','cranelift','net']);
  assert.ok(input.positive.length>=12&&input.checked_overflow.length>=4&&input.compile_reject.length>=4);
  const all=[...input.positive,...input.checked_overflow,...input.compile_reject], ids=new Set();
  for(const x of all){
    assert.match(x.id,/^[a-z][a-z0-9-]*$/);
    assert.ok(!ids.has(x.id),'duplicate case id '+x.id);ids.add(x.id);
    assert.equal(typeof x.expression,'string');
    assert.ok(x.expression.length>0&&x.expression.length<256);
    assert.doesNotMatch(x.expression,/[;\n\r{}]/,'guest source injection');
  }
  for(const x of [...input.positive,...input.checked_overflow])
    assert.match(x.expression,/^[0-9+*()\s-]+$/,'out of common scalar intersection');
  for(const x of input.positive){
    assert.match(x.expected_i64,/^(?:0|-?[1-9][0-9]*)$/);
    checked(BigInt(x.expected_i64));
  }
  // Semantic validation: a manifest shape cannot launder incorrect host results.
  const expressions=new Set();
  for(const [kind,entries] of [
    ['positive',input.positive],
    ['checked_overflow',input.checked_overflow],
    ['compile_reject',input.compile_reject]
  ]){
    for(const x of entries){
      const allowed=kind==='positive'?['expected_i64','expression','id']:['expression','id'];
      assert.deepEqual(Object.keys(x).sort(),allowed,'unexpected/missing '+kind+' fields');
      assert.equal(x.expression.trim(),x.expression,'expression must be canonical');
      assert.ok(!expressions.has(x.expression),'duplicate expression '+x.expression);
      expressions.add(x.expression);
    }
  }
  for(const x of input.positive)
    assert.equal(evaluate(x.expression),BigInt(x.expected_i64),'incorrect expected result: '+x.id);
  for(const x of input.checked_overflow)
    assert.throws(()=>evaluate(x.expression),/signed 64 overflow/,'not numeric overflow: '+x.id);
  for(const x of input.compile_reject)
    assert.throws(()=>evaluate(x.expression),'valid scalar misclassified as reject: '+x.id);
  assert.equal(input.known_drift.length,1,'drift inventory cannot silently change');
  assert.deepEqual(input.known_drift[0],{
    id:'legacy-percent-operator',
    expression:'7 % 3',
    required_language_policy:'reject-percent-operator',
    observed_older_backends:'some still accept literal-divisor signed remainder; not a parity pass'
  });
  return ids.size;
}
test('versioned manifest retains five backends, unique cases, and explicit drift',()=>{
  assert.equal(validate(c),c.positive.length+c.checked_overflow.length+c.compile_reject.length);
});
for(const x of c.positive)test('host positive '+x.id,()=>assert.equal(evaluate(x.expression),BigInt(x.expected_i64)));
for(const x of c.checked_overflow)test('host checked overflow '+x.id,()=>
  assert.throws(()=>evaluate(x.expression),/signed 64 overflow/));
for(const x of c.compile_reject)test('host parse rejection '+x.id,()=>assert.throws(()=>evaluate(x.expression)));
test('adversarial manifest mutations fail closed',()=>{
  const copy=()=>JSON.parse(JSON.stringify(c));
  const dup=copy();dup.positive[1].id=dup.positive[0].id;assert.throws(()=>validate(dup));
  const spoof=copy();spoof.classification='all-five-native-backends-verified';assert.throws(()=>validate(spoof));
  const injection=copy();injection.positive[0].expression+='; import evil';assert.throws(()=>validate(injection));
  const range=copy();range.positive[0].expected_i64='9223372036854775808';assert.throws(()=>validate(range));
  const missing=copy();missing.required_backends=['java','llvm'];assert.throws(()=>validate(missing));
  const drift=copy();drift.known_drift=[];assert.throws(()=>validate(drift));
});

test('mutated expected result cannot masquerade as a positive case',()=>{
  const m=structuredClone(c);m.positive[0].expected_i64='1';
  assert.throws(()=>validate(m),/incorrect expected result/);
});
test('valid expression cannot masquerade as checked overflow',()=>{
  const m=structuredClone(c);m.checked_overflow[0].expression='1 + 2';
  assert.throws(()=>validate(m),/not numeric overflow/);
});
test('invalid syntax cannot masquerade as checked overflow',()=>{
  const m=structuredClone(c);m.checked_overflow[0].expression='1 + )';
  assert.throws(()=>validate(m));
});
test('checked overflow cannot masquerade as a positive case',()=>{
  const m=structuredClone(c);m.positive[0].expression='9223372036854775807 + 1';
  assert.throws(()=>validate(m));
});
test('valid scalar cannot masquerade as a compile rejection',()=>{
  const m=structuredClone(c);m.compile_reject[0].expression='1 + 2';
  assert.throws(()=>validate(m),/valid scalar misclassified/);
});
test('a duplicate source with a fresh ID cannot inflate vector coverage',()=>{
  const m=structuredClone(c);m.positive[1].expression=m.positive[0].expression;
  assert.throws(()=>validate(m),/duplicate expression/);
});
test('hidden positive-case fields are rejected',()=>{
  const m=structuredClone(c);m.positive[0].certified_backend='native-executed';
  assert.throws(()=>validate(m),/unexpected\/missing/);
});
test('missing expected value is rejected instead of deriving one silently',()=>{
  const m=structuredClone(c);delete m.positive[0].expected_i64;
  assert.throws(()=>validate(m));
});
test('noncanonical leading/trailing whitespace is rejected',()=>{
  const m=structuredClone(c);m.positive[0].expression=' '+m.positive[0].expression;
  assert.throws(()=>validate(m),/expression must be canonical/);
});
test('manifest cannot erase the percent-operator drift gate',()=>{
  const m=structuredClone(c);m.known_drift[0].expression='7 + 3';
  assert.throws(()=>validate(m));
});
test('manifest cannot claim unchecked wraparound as positive',()=>{
  const m=structuredClone(c);m.positive[0].expression='-9223372036854775808 - 1';
  assert.throws(()=>validate(m));
});
test('manifest cannot hide an extra backend inside the required set',()=>{
  const m=structuredClone(c);m.required_backends.push('host-oracle');
  assert.throws(()=>validate(m));
});
