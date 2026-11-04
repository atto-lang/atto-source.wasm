// A compiler exit 1 is not sufficient to prove that duplicate methods were
// rejected by the receiver-erased overload selector. The primary diagnostic
// must name the exact slot and exact independently pinned fixture.
export function assertPrimaryReceiverSlotRejection(result, slot, sourceFile) {
  if(!/^x\/[01]$/.test(slot) || !/^[a-z0-9-]+\.ores$/.test(sourceFile) ||
     !result || result.error || result.signal ||
     result.status !== 1 || result.stdout !== "") {
    throw Error("receiver-slot rejection must be compiler-owned (exit 1, no IR)");
  }
  const first=String(result.stderr||"").split(/\r?\n/,1)[0];
  const expected="oreslang-llvmc: duplicate native method name/arity '"+
    slot+"' (self receiver does not count toward arity) at byte ";
  if(!first.startsWith(expected)) {
    throw Error("receiver-slot error must be the primary compiler diagnostic");
  }
  const match=/^([0-9]+) \[file: ([a-z0-9-]+\.ores)\]$/.exec(first.slice(expected.length));
  if(!match || !Number.isSafeInteger(Number(match[1])) ||
     match[2]!==sourceFile) {
    throw Error("receiver-slot diagnostic has wrong offset or source file");
  }
  return true;
}
