import {ActorArena} from "../src/actor-arena.mjs";
import {ActorMixedShard} from "../src/actor-mixed-shard.mjs";
export function openStore(options,actorId){
  const arena=new ActorArena({actorId,incarnation:1,kind:"shared"});
  const turn=arena.beginTurn();
  let shard;
  try{shard=new ActorMixedShard(arena,turn,options);}
  catch(error){arena.endTurn(turn);arena.retire();throw error;}
  let closed=false;
  return {
    byteLength:shard.byteLength,payloadBytes:shard.payloadBytes,
    read:(row,field)=>shard.read(turn,row,field),
    write:(row,field,value)=>shard.write(turn,row,field,value),
    offset:(row,field)=>shard.address(row,field).absoluteByteOffset,
    close:()=>{
      if(closed)return;
      shard.release(turn);arena.endTurn(turn);arena.retire();closed=true;
    }
  };
}
