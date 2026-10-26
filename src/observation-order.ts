import type {Observation} from './types.js';

export function acceptsObservation(current:Observation,incoming:Observation):boolean {
  if(current.captureSeq!==undefined&&incoming.captureSeq!==undefined){
    if(incoming.captureSeq!==current.captureSeq)return incoming.captureSeq>current.captureSeq;
    if(current.observationRevision!==undefined&&incoming.observationRevision!==undefined)return incoming.observationRevision>=current.observationRevision;
  }
  return incoming.collectedAt>=current.collectedAt;
}

export const observationExpired=(state:Observation,now=Date.now())=>!!state.uiError||!state.collectedAt||now-state.collectedAt>15000;
