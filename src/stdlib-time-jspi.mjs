// Explicit, opt-in JSPI timer host boundary for the future std/time guest ABI.
// NOT wired into the existing no-import guest-worker admission path.
const MAX_NS=(1n<<63n)-1n, NS_PER_MS=1000000n, TIMER_MAX_MS=2147483647n;
export class TimeJspiError extends Error {
  constructor(code){super(code);this.name='TimeJspiError';this.code=code;}
}
const error=code=>new TimeJspiError(code);
function systemNowNs(){
  const raw=performance.now()*1e6;
  if(!Number.isFinite(raw)||raw<0||!Number.isSafeInteger(Math.floor(raw)))
    throw error('InvalidMonotonicClock');
  return BigInt(Math.floor(raw));
}
function boundedDelay(ns){
  const ms=(ns+NS_PER_MS-1n)/NS_PER_MS;
  return Number(ms>TIMER_MAX_MS?TIMER_MAX_MS:ms);
}
/**
 * Construct only after independent trusted host-import admission.
 * The existing untrusted guest-worker MUST continue to instantiate with {}.
 * An owner can close this boundary and cancel all pending suspensions.
 */
export function createTimeJspiBoundary({
  Suspending=WebAssembly.Suspending,
  now_ns=systemNowNs,
  register=setTimeout,
  unregister=clearTimeout,
  max_pending=64
}={}){
  if(typeof Suspending!=='function'||typeof now_ns!=='function'||
     typeof register!=='function'||typeof unregister!=='function'||
     !Number.isSafeInteger(max_pending)||max_pending<1||max_pending>4096)
    throw error('InvalidTimeHost');
  let closed=false;
  const live=new Set();
  function sample(){
    const now=now_ns();
    if(typeof now!=='bigint'||now<0n||now>MAX_NS)
      throw error('InvalidMonotonicClock');
    return now;
  }
  function sleepNs(delay){
    if(typeof delay!=='bigint')throw error('DurationType');
    if(delay<0n)throw error('NegativeDuration');
    if(delay>MAX_NS)throw error('DurationOverflow');
    if(closed)throw error('TimeHostClosed');
    const started=sample();
    if(delay>MAX_NS-started)throw error('DeadlineOverflow');
    if(live.size>=max_pending)throw error('TimerCapacityExceeded');
    const due=started+delay;
    let last=started,handle=null,finished=false;
    return new Promise((resolve,reject)=>{
      const record={cancel:()=>finish(error('TimeHostClosed'))};
      const finish=err=>{
        if(finished)return;
        finished=true;
        if(handle!==null){
          const h=handle;handle=null;
          try{unregister(h)}catch(e){err??=e}
        }
        live.delete(record);
        if(err)reject(err);else resolve();
      };
      const arm=ms=>{
        let returned=false;
        try {
          const h=register(()=>{
            if(!returned){finish(error('SynchronousTimerCallback'));return;}
            handle=null;
            if(finished)return;
            let now;
            try{now=sample()}catch(e){finish(e);return;}
            if(now<last){finish(error('ClockWentBackwards'));return;}
            last=now;
            if(now>=due){finish();return;}
            arm(boundedDelay(due-now));
          },ms);
          returned=true;
          handle=h;
          if(finished){handle=null;unregister(h);}
        }catch(e){finish(e);}
      };
      live.add(record);
      if(closed){finish(error('TimeHostClosed'));return;}
      arm(delay===0n?0:boundedDelay(delay));
    });
  }
  // WebAssembly.Suspending is mandatory. Do not convert Promise into a
  // synchronous Wasm import, or accept a JS Promise without JSPI lowering.
  const sleep_ns=new Suspending(sleepNs);
  return Object.freeze({
    sleep_ns,
    monotonic_now:sample,
    get pending(){return live.size;},
    close(){
      if(closed)return false;
      closed=true;
      for(const record of [...live])record.cancel();
      return true;
    }
  });
}
