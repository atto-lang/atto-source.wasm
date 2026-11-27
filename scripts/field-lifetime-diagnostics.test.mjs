import test from 'node:test';
import assert from 'node:assert/strict';
import {requireNativeDiagnostic,readBrowserDiagnostic,requireBrowserCompileStatus,requireBrowserDiagnostic} from './field-lifetime-diagnostics.mjs';
const path='/tmp/fixture.atto';
const bytes=s=>new TextEncoder().encode(s);
test('exact native diagnostic accepted',()=>requireNativeDiagnostic(bytes(path+': 1:42: E_BORROW: active loan\n'),path,'E_BORROW'));
test('wrong actual code containing expected code rejected',()=>assert.throws(()=>requireNativeDiagnostic(bytes(path+': 1:2: E_SYNTAX: nested: E_BORROW: text\n'),path,'E_BORROW')));
test('wrong source rejected',()=>assert.throws(()=>requireNativeDiagnostic(bytes('/tmp/other.atto: 1:2: E_BORROW: loan\n'),path,'E_BORROW')));
test('multiple or malformed diagnostics rejected',()=>{
  for(const suffix of ['1:2: E_BORROW: loan\n1:3: E_TYPE: second\n','E_BORROW: missing position\n','1:2: E_BORROW: \n','1:2: E_BORROW: loan']) assert.throws(()=>requireNativeDiagnostic(bytes(path+': '+suffix),path,'E_BORROW'));
});
test('native malformed UTF-8 and oversized output rejected',()=>{
  assert.throws(()=>requireNativeDiagnostic(Uint8Array.of(255),path,'E_BORROW'));
  assert.throws(()=>requireNativeDiagnostic(new Uint8Array(65537),path,'E_BORROW'));
});
test('browser reads exact diagnostic at nonzero offset',()=>assert.equal(readBrowserDiagnostic(bytes('xxE_BORROW: loan\0tail'),2),'E_BORROW: loan'));
test('browser bounds and empty diagnostics rejected',()=>{
  const memory=bytes('x\0');
  for(const offset of [-1,2,0.5,NaN,1]) assert.throws(()=>readBrowserDiagnostic(memory,offset));
});
test('browser scan bounded and requires terminator',()=>{
  const memory=new Uint8Array(65538).fill(65);
  memory[65536]=0;
  assert.equal(readBrowserDiagnostic(memory,0).length,65536);
  memory[65536]=65;memory[65537]=0;
  assert.throws(()=>readBrowserDiagnostic(memory,0));
  assert.throws(()=>readBrowserDiagnostic(bytes('unterminated'),0));
  assert.throws(()=>readBrowserDiagnostic(Uint8Array.of(255,0),0));
});

test('browser compiler accepts only normal ABI v2 statuses',()=>{
  for(const status of [0,1]) assert.equal(requireBrowserCompileStatus(status),status);
  for(const status of [-1,2,255,NaN,Infinity,0.5,'1',null,undefined]) assert.throws(()=>requireBrowserCompileStatus(status));
});
test('browser diagnostic requires exact code and a single nonempty message',()=>{
  requireBrowserDiagnostic('E_BORROW: active loan','E_BORROW');
  requireBrowserDiagnostic('E_BORROW: nested: field loan','E_BORROW');
  for(const diagnostic of ['E_BORROW','E_BORROW:', 'E_BORROW: ', 'E_BORROW: loan\n','E_BORROW: loan\r\nE_TYPE: second','E_SYNTAX: nested E_BORROW: loan','E_BORROWED: loan',' E_BORROW: loan','E_BORROW: \t',null]) assert.throws(()=>requireBrowserDiagnostic(diagnostic,'E_BORROW'));
});
