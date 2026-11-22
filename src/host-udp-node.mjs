import {createSocket} from 'node:dgram';
import {snapshotGuestBytes} from './snapshot-guest-bytes.mjs';

// Trusted Node host adapter ONLY. Not a Wasm/browser guest import; the embedding
// host MUST provide its real, scoped permission engine as authorize().
// All numeric endpoints are IPv4 loopback. No DNS, multicast or broadcast.
export async function openNodeUdpLoopback({port=0, authorize, maxPackets=64, maxBytes=262144}={}) {
  if (typeof authorize !== 'function') throw new TypeError('trusted authorize required');
  if (!Number.isInteger(port) || port<0 || port>65535) throw new RangeError('bind port');
  if (!Number.isInteger(maxPackets) || maxPackets<1 || maxPackets>1024 ||
      !Number.isInteger(maxBytes) || maxBytes<1 || maxBytes>4194304) throw new RangeError('queue quota');
  authorize('127.0.0.1:'+port, 'udp.bind');
  const socket=createSocket({type:'udp4',reuseAddr:false});
  try {
    await new Promise((resolve,reject)=>{
      const onError=error=>{socket.off('listening',onReady);reject(error)};
      const onReady=()=>{socket.off('error',onError);resolve()};
      socket.once('error',onError);
      socket.once('listening',onReady);
      try {socket.bind(port,'127.0.0.1')}catch(error){socket.off('error',onError);socket.off('listening',onReady);reject(error)}
    });
  } catch(error) { try { socket.close() }catch{} throw error }
  const queue=[];
  let queuedBytes=0, dropped=0, waiter=null, closed=false, terminalError=null, closePromise=null;
  const pendingSends=new Set();
  const localPort=socket.address().port;
  const requireLocal=operation=>{
    if(closed) throw new Error('UDP socket closed');
    if(terminalError) throw terminalError;
    authorize('127.0.0.1:'+port,operation);
  };
  const drop=()=>{if(dropped<2147483647)dropped++};
  const handoff=(record, capacity)=>{
    if(record.bytes.length>capacity) throw new RangeError('UDP datagram truncated; discarded');
    return Object.freeze({bytes:Uint8Array.from(record.bytes),source:Object.freeze({host:'127.0.0.1',port:record.port})});
  };
  socket.on('message',(data,peer)=>{
    if(closed)return;
    if(peer.family!=='IPv4'||peer.address!=='127.0.0.1'||!Number.isInteger(peer.port)||peer.port<1){drop();return}
    try{requireLocal('udp.recv_from');authorize('127.0.0.1:'+peer.port,'udp.recv_from')}catch{drop();return}
    if(data.length>65507){drop();return}
    const record={bytes:Buffer.from(data),port:peer.port};
    if(waiter){const w=waiter;waiter=null;w.cleanup();try{w.resolve(handoff(record,w.capacity))}catch(error){w.reject(error)};return}
    if(queue.length>=maxPackets||record.bytes.length>maxBytes-queuedBytes){drop();return}
    queue.push(record);queuedBytes+=record.bytes.length;
  });
  socket.on('error',error=>{
    terminalError=error;
    if(waiter){const w=waiter;waiter=null;w.cleanup();w.reject(error)}
  });
  const close=()=>{
    if(closePromise)return closePromise;
    closed=true;
    if(waiter){const w=waiter;waiter=null;w.cleanup();w.reject(new Error('UDP socket closed'))}
    for(const entry of queue)entry.bytes.fill(0);
    queue.length=0;queuedBytes=0;
    for(const s of pendingSends)s.reject(new Error('UDP socket closed'));
    pendingSends.clear();
    closePromise=new Promise(resolve=>socket.close(resolve));
    return closePromise;
  };
  return Object.freeze({
    local_port:()=>localPort,
    stats:()=>Object.freeze({queued_packets:queue.length,queued_bytes:queuedBytes,dropped_packets:dropped}),
    async send_to(bytes,peerPort){
      requireLocal('udp.send_to');
      if(!Number.isInteger(peerPort)||peerPort<1||peerPort>65535)throw new RangeError('peer port');
      const detached=snapshotGuestBytes(bytes,65507);
      authorize('127.0.0.1:'+peerPort,'udp.send_to');
      const snapshot=Buffer.from(detached);
      return new Promise((resolve,reject)=>{
        let settled=false;
        const entry={reject:error=>{if(settled)return;settled=true;pendingSends.delete(entry);reject(error)}};
        pendingSends.add(entry);
        try{socket.send(snapshot,peerPort,'127.0.0.1',error=>{
          if(settled)return;settled=true;pendingSends.delete(entry);
          if(error)reject(error);else resolve(snapshot.length);
        })}catch(error){entry.reject(error)}
      });
    },
    recv_from(capacity,{signal}={}){
      requireLocal('udp.recv_from');
      if(!Number.isInteger(capacity)||capacity<1||capacity>65507)throw new RangeError('recv capacity');
      if(waiter)throw new Error('concurrent UDP recv not permitted');
      if(signal?.aborted)return Promise.reject(signal.reason??new Error('aborted'));
      if(queue.length){const record=queue.shift();queuedBytes-=record.bytes.length;return Promise.resolve(handoff(record,capacity))}
      return new Promise((resolve,reject)=>{
        const w={resolve,reject,capacity,cleanup:()=>signal?.removeEventListener('abort',onAbort)};
        const onAbort=()=>{if(waiter===w)waiter=null;w.cleanup();reject(signal.reason??new Error('aborted'))};
        waiter=w;
        signal?.addEventListener('abort',onAbort,{once:true});
        if(signal?.aborted)onAbort();
      });
    },
    close
  });
}
