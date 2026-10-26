// Which machine builds the gesture.
//
// There are two honest options and they are good at different things:
//
//   framework — `input pswipe` runs inside system_server and synthesises the
//     whole timeline there: one downTime for the gesture, minimum-jerk
//     positions, and MotionEvents that carry four history samples because the
//     panel samples every ~4 ms. Nothing on the host can produce that shape,
//     because the scrcpy control protocol carries one sample per message and
//     has no timestamp field at all.
//
//   client — replay a sampled trajectory through scrcpy. Works on any device
//     and on stock images, keeps the low-latency path, but every injected
//     point becomes its own MotionEvent, so getHistorySize() is always 0.
//
// `auto` prefers the framework path when the image advertises it and falls back
// to the client path otherwise. Pinch is always client: `pswipe` is single
// pointer.

import type {GestureKind, GestureSpec, Point, Realism} from './gesture-plan.js';

export interface DeviceCapabilities {
  /** The image has `input pswipe` (i.e. it carries the sandbox gesture patch). */
  pswipe: boolean;
  model: string;
  sdk: number;
}

export type ResolvedBackend = 'framework' | 'client' | 'off' | 'unsupported';

/** Conservative default for an image we have not probed yet. */
export const UNPROBED: DeviceCapabilities = {pswipe: false, model: '', sdk: 0};

export function chooseBackend(realism: Realism, caps: DeviceCapabilities, kind: GestureKind): ResolvedBackend {
  if (realism === 'off') return 'off';
  if (realism === 'client') return 'client';
  if (realism === 'framework') return caps.pswipe && kind !== 'pinch' ? 'framework' : 'unsupported';
  // auto
  return caps.pswipe && kind !== 'pinch' ? 'framework' : 'client';
}

/**
 * Arguments for the on-device `input` command.
 *
 * Takes the *geometry*, not a sampled plan: `pswipe` applies the minimum-jerk
 * timing itself, so handing it already-time-shaped positions would run the
 * curve twice and distort both speed and distance.
 */
export function frameworkArgv(spec: GestureSpec, holdMs: number, width: number, height: number): string[] {
  const r = (v: number, hi: number) => String(Math.max(0, Math.min(hi - 1, Math.round(v))));

  if (spec.kind === 'tap') {
    return ['input', 'tap', r(spec.x ?? 0, width), r(spec.y ?? 0, height)];
  }
  if (spec.kind === 'longPress') {
    const x = r(spec.x ?? 0, width);
    const y = r(spec.y ?? 0, height);
    return ['input', 'swipe', x, y, x, y, String(Math.round(holdMs))];
  }

  const path: Point[] = spec.waypoints?.length
    ? spec.waypoints
    : [{x: spec.x1 ?? 0, y: spec.y1 ?? 0}, {x: spec.x2 ?? 0, y: spec.y2 ?? 0}];

  // The command line has a practical length limit and a straight swipe only
  // needs its two ends, so thin long polylines by keeping evenly spaced points.
  const maxPoints = 64;
  const kept = path.length <= maxPoints
    ? path
    : Array.from({length: maxPoints}, (_, i) => path[Math.round((i * (path.length - 1)) / (maxPoints - 1))]!);

  const argv = ['input', 'pswipe', String(Math.max(1, Math.round(spec.durationMs ?? 350)))];
  for (const p of kept) argv.push(r(p.x, width), r(p.y, height));
  return argv;
}

/** Human-readable reason a requested backend could not be used. */
export function unsupportedReason(realism: Realism, caps: DeviceCapabilities, kind: GestureKind): string {
  if (kind === 'pinch') return '端上合成目前只支持单指，双指手势只能用客户端采样流';
  if (!caps.pswipe) {
    return `这台设备（${caps.model || '未知型号'}）的 input 命令没有 pswipe，无法端上合成；` +
      `用 realism:'client' 走客户端采样流`;
  }
  return `realism:'${realism}' 无法用于 ${kind}`;
}
