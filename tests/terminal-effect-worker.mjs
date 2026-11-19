import { parentPort } from 'node:worker_threads';
import { makeTerminalEffectNotice } from '../runtime/terminal-effect-notice.mjs';

parentPort.once('message', ({ actor_id, parent_id, generation }) => {
  parentPort.postMessage(makeTerminalEffectNotice({
    actor_id, parent_id, generation, sequence: 0,
    effect: 'raise', error_type: 'DatabaseError', message: 'lost quorum'
  }));
});
