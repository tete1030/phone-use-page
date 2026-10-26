export interface AndroidNode {
  id: string; parentId: string | null; depth: number; index: number;
  text: string; description: string; resourceId: string; className: string; package: string;
  bounds: [number, number, number, number]; enabled: boolean; clickable: boolean;
  longClickable: boolean; checkable: boolean; checked: boolean; focused: boolean;
  editable: boolean; password: boolean; scrollable: boolean; visible: boolean;
  fingerprint: string; selector: Record<string, unknown>; instance: number;
}
export interface Observation {
  connected: boolean; serial: string; model: string; android: string; system: string;
  width: number; height: number; rotation: number; screenOn: boolean;
  locked?: boolean | null;
  snapshotId: string; collectedAt: number; nodes: AndroidNode[];
  windowId?: string; uiElapsedMs?: number;
  captureSeq?:number; captureStartedAt?:number; observationRevision?:number;
  foregroundApp: string; focus: AndroidNode | null; focusEpoch: number;
  powerCollectedAt?:number; powerError?:string|null; focusReason?:string|null; keyboardBackend?:string; keepAwake?:boolean; keepAwakeError?:string; summary?:{battery:number|null;charging:boolean;inputMethod:string;network:string};
  uiError: string | null; videoError: string | null; controlAvailable: boolean;
}
export interface Target { id: string; fingerprint: string; snapshotId?: string; windowId?:string }
export interface ActionResult { execution?:'sent';verification?:'verified'|'not_verified'|'inconclusive'|'failed';requestId: string; status: 'ok'; backend: string; snapshotId: string; result?: unknown; jitter?:boolean; point?:{x:number;y:number};sourceTarget?:string;actionTarget?:string }
export interface Selector { text?: string; resourceId?: string; description?: string; className?: string; package?: string }
export interface AppEntry {packageName:string;thirdParty:boolean;launchers:string[]}
export interface ActivityEntry {index:number;token:string;userId:number;component:string;state:string}
export interface AndroidTask {taskId:number;userId:number;type:string;baseComponent:string;packageName:string;topComponent:string|null;activities:ActivityEntry[];foreground:boolean;available:boolean;switchable:boolean;fingerprint:string}
export interface Navigation {userId:number;collectedAt:number;locked:boolean|null;current:{taskId:number;userId:number;component:string}|null;tasks:AndroidTask[];internalStack:'unknown'}
export interface ApplicationState {catalog:{userId:number;collectedAt:number;apps:AppEntry[]};navigation:Navigation;processes:{packageName:string;processes:{pid:number;uid:string;name:string}[]}[];collectedAt:number;processScope:string}
export class ConsoleError extends Error {
  execution?:'sent';verification?:ActionResult['verification'];
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
