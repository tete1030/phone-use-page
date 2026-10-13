export const wssFailureStages = ['socket','metadata','capability','decoder-init','packet','backpressure','decode','render'] as const;
export interface WssFailure {
  provider: 'wss';
  stage: typeof wssFailureStages[number];
  code: string;
  error: {name: string; message: string};
  elapsedMs: number;
  socketState: number;
  closeCode: number | null;
  width: number;
  height: number;
  codec: number | null;
  avcCodec: string | null;
  bytesReceived: number;
  packetsReceived: number;
  drawnFrames: number;
  queuedBytes: number;
  lastPacket: {kind: number | null; bytes: number} | null;
  capabilities: {secureContext: boolean; videoDecoder: boolean; createImageBitmap: boolean; bitmapRenderer: boolean | null};
}
export type WssFailureReport = WssFailure & {attemptId: string; assetVersion: string | null};

export function diagnosticText(value: string, limit = 384) {
  return value
    .replace(/\b(?:https?|wss?|turns?):[^\s"'<>]+/gi, '[url]')
    .replace(/\b(cookie|authorization)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\r\n]*)/gi, '$1=[redacted]')
    .replace(/\b(password|token|cookie|credential|authorization|secret|api[_-]?key|ice-pwd|csrf|connection)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[redacted]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit);
}
export function diagnosticError(error: unknown) {
  const value = error && typeof error === 'object' ? error as {name?: unknown; message?: unknown} : null;
  return {name: diagnosticText(typeof value?.name === 'string' ? value.name : 'Error', 64),
    message: diagnosticText(typeof value?.message === 'string' ? value.message : String(error ?? 'Unknown error'))};
}
