/** Browser task-turn primitive. A macrotask yield, not a Promise microtask loop.
 * Compiler-lowered task continuations and actor turns share this carrier hook.
 */
export function createTurnQueue({MessageChannelImpl=globalThis.MessageChannel}={}) {
  if(typeof MessageChannelImpl!=='function')throw Error('E_SCHEDULER: MessageChannel unavailable');
  const channel=new MessageChannelImpl(),pending=[];
  let closed=false;
  channel.port1.onmessage=()=>{if(!closed)pending.shift()?.resolve();};
  return Object.freeze({
    yieldTurn(){
      if(closed)return Promise.reject(Error('E_TASK_CANCELLED: tenant turn queue closed'));
      if(pending.length>=20000)return Promise.reject(Error('E_TASK_LIMIT: ready continuation queue full'));
      return new Promise((resolve,reject)=>{
        const turn={resolve,reject};pending.push(turn);
        try{channel.port2.postMessage(0);}
        catch(error){pending.splice(pending.indexOf(turn),1);reject(error);}
      });
    },
    close(){
      if(closed)return;closed=true;
      channel.port1.onmessage=null;channel.port1.close();channel.port2.close();
      for(const turn of pending.splice(0))turn.reject(Error('E_TASK_CANCELLED: tenant turn queue closed'));
    }
  });
}
