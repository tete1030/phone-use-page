interface TrackProcessor {
  readable: ReadableStream<VideoFrame>;
}
type ProcessorConstructor = new (options: {track: MediaStreamTrack; maxBufferSize: number}) => TrackProcessor;

export class VideoPresentationHealth {
  private previousDecoded: number | null = null;
  private previousFrameAt: number | null = null;
  private undrawnSince: number | null = null;
  check(state: {paused: boolean; hidden: boolean; now: number; lastFrameAt: number | null; requiredAfter: number; decoded: number | null}) {
    const advanced = this.previousDecoded !== null && state.decoded !== null && state.decoded > this.previousDecoded;
    if (state.lastFrameAt !== this.previousFrameAt || state.paused || state.hidden ||
      state.decoded === null || this.previousDecoded !== null && state.decoded < this.previousDecoded) this.undrawnSince = null;
    this.previousDecoded = state.decoded; this.previousFrameAt = state.lastFrameAt;
    if (state.paused || state.hidden || state.lastFrameAt === null || !advanced) return false;
    // A first frame after a long still image gets its own presentation grace period.
    this.undrawnSince ??= state.now;
    return state.now - Math.max(state.lastFrameAt, state.requiredAfter, this.undrawnSince) >= 8000;
  }
}

export function createWebRtcRenderer(options: {
  onFrame: (width: number, height: number) => void;
  onFailure: (reason: string) => void;
}) {
  const Processor = (globalThis as typeof globalThis & {MediaStreamTrackProcessor?: ProcessorConstructor}).MediaStreamTrackProcessor;
  let surface: HTMLCanvasElement | HTMLVideoElement = document.createElement('canvas');
  let context: CanvasRenderingContext2D | null = null;
  let fallbackReason: string | null = null;
  let closed = false, epoch = 0, disposeTrack = () => {};

  const useVideo = (reason: string) => {
    const previous = surface, video = document.createElement('video');
    video.className = previous.className;
    video.style.cssText = previous.style.cssText;
    for (const attribute of previous.attributes) video.setAttribute(attribute.name, attribute.value);
    video.autoplay = true; video.muted = true; video.playsInline = true;
    previous.replaceWith(video);
    surface = video; context = null; fallbackReason = reason;
    return video;
  };
  if (Processor) {
    try { context = surface.getContext('2d', {alpha: false}); } catch {}
  }
  if (!Processor || !context) useVideo(!Processor ? '浏览器未提供主线程 TrackProcessor' : 'Canvas 2D 不可用');

  const retryPlayback = () => {
    if (!closed && surface instanceof HTMLVideoElement && surface.srcObject) {
      const video = surface, currentEpoch = epoch;
      void video.play().catch(() => { if (!closed && epoch === currentEpoch && surface === video) options.onFailure('浏览器拒绝播放视频'); });
    }
  };
  const visible = () => { if (!document.hidden) retryPlayback(); };
  document.addEventListener('visibilitychange', visible);

  const start = (track: MediaStreamTrack) => {
    if (closed) { track.stop(); return; }
    const currentEpoch = ++epoch;
    disposeTrack();
    let reader: ReadableStreamDefaultReader<VideoFrame> | undefined;
    let frameCallback: number | undefined;
    const active = () => !closed && epoch === currentEpoch;
    const ended = () => { if (active()) options.onFailure('WebRTC 视频轨道已结束'); };
    track.addEventListener('ended', ended);
    disposeTrack = () => {
      track.removeEventListener('ended', ended);
      // Cancel pending reads before releasing the track; late frames still close in the loop.
      void reader?.cancel().catch(() => {});
      if (surface instanceof HTMLVideoElement) {
        if (frameCallback !== undefined) surface.cancelVideoFrameCallback(frameCallback);
        surface.pause(); surface.srcObject = null;
      }
      track.stop();
    };

    if (surface instanceof HTMLCanvasElement) {
      try { reader = new Processor!({track, maxBufferSize: 1}).readable.getReader(); }
      catch { useVideo('TrackProcessor 无法读取此视频轨道'); }
    }
    if (reader) {
      const frameReader = reader, canvas = surface as HTMLCanvasElement, drawing = context!;
      void (async () => {
        try {
          while (active()) {
            const {value: frame, done} = await frameReader.read();
            if (done) { if (active()) options.onFailure('WebRTC 视频帧读取已结束'); break; }
            try {
              if (!active()) continue;
              const width = frame.displayWidth, height = frame.displayHeight;
              if (width <= 0 || height <= 0) continue;
              if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
              drawing.drawImage(frame, 0, 0, width, height);
              options.onFrame(width, height);
            } finally { frame.close(); }
          }
        } catch { if (active()) options.onFailure('WebRTC 视频绘制失败'); }
        finally { frameReader.releaseLock(); }
      })();
    } else {
      const video = surface as HTMLVideoElement;
      video.srcObject = new MediaStream([track]);
      const frame = () => {
        if (!active()) return;
        if (video.videoWidth > 0 && video.videoHeight > 0) options.onFrame(video.videoWidth, video.videoHeight);
        frameCallback = video.requestVideoFrameCallback(frame);
      };
      frameCallback = video.requestVideoFrameCallback(frame);
      retryPlayback();
    }
  };
  return {
    get surface() { return surface; }, start, resume: retryPlayback,
    snapshot: () => ({renderer: surface instanceof HTMLCanvasElement ? 'track-processor-canvas' : 'html-video', rendererFallbackReason: fallbackReason}),
    close: () => { if (closed) return; closed = true; epoch++; document.removeEventListener('visibilitychange', visible); disposeTrack(); },
  };
}
