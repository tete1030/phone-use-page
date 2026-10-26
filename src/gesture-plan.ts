// Shared motion layer for both input paths.
//
// Two different problems end up in the same place:
//
//   * Scripted gestures start from an intent ("swipe from A to B") and must be
//     turned into a realistic sample stream.
//   * Live touch starts from real samples, but they arrive downsampled by the
//     browser and must be lifted onto a fixed grid without inventing a shape.
//
// Both need "a sparse set of real points -> a smooth 4 ms trajectory", so the
// curve code lives here once and nothing else in the tree reimplements it.
//
// Why monotone cubic Hermite rather than linear:
//
//   Linear interpolation produces piecewise-constant velocity: constant speed
//   along each segment, then a jump at every sample. Stitching 16 ms segments
//   that way is visible in the MotionEvent stream. A cubic Hermite through the
//   same points is C1 — speed is continuous — which is what a finger does.
//
//   Plain Catmull-Rom would overshoot at direction reversals and put the finger
//   where it never was. Fritsch-Carlson monotonicity limiting removes that: on
//   every interval the curve cannot leave the box spanned by its endpoints.

export interface GesturePoint { id: number; x: number; y: number }
export interface GestureSample { t: number; points: GesturePoint[] }

export type GestureKind = 'tap' | 'longPress' | 'swipe' | 'drag' | 'pinch';
export type Realism = 'auto' | 'off' | 'framework' | 'client';

export interface GesturePlan {
  kind: GestureKind;
  /** Total gesture length in milliseconds, from the first DOWN to the last UP. */
  durationMs: number;
  /** For tap/longPress: how long the finger stays down. */
  holdMs?: number;
  /** Sampled trajectory. A tap has a single sample at t=0. */
  samples: GestureSample[];
}

export interface Point { x: number; y: number }
export interface TimedPoint extends Point { t: number }

/** Sampling interval used for every synthesized trajectory (the panel's rate). */
export const GRID_MS = 4;

/**
 * Minimum-jerk position curve: fraction of the distance covered after fraction
 * t of the time. Measured on this device, a real swipe's fastest sample lands
 * at 40-53% of the gesture, which is where this curve peaks.
 */
export function minJerk(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * t * (10 - 15 * t + 6 * t * t);
}

/** Deterministic PRNG so a seeded gesture reproduces exactly in tests. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Resample a real sample sequence onto a fixed grid.
 *
 * The output passes through every input point exactly and never leaves the
 * per-axis range of the interval it belongs to. `before` supplies up to two
 * preceding real samples so the tangent at the first new point is continuous
 * with the previous batch; without it every batch seam would show a velocity
 * step.
 *
 * Input must be sorted by `t` with strictly increasing times.
 */
export function resample(points: TimedPoint[], gridMs = GRID_MS, before: TimedPoint[] = []): TimedPoint[] {
  if (points.length === 0) return [];
  if (points.length === 1) return [{ ...points[0] }];

  const all = [...before.slice(-2), ...points];
  const tangents = monotoneTangents(all);

  // When previous samples are supplied, start at the first grid slot after
  // them instead of at this batch's first sample. Otherwise the gap between
  // two batches is never interpolated: the previous batch stopped at its last
  // sample and this one starts at its first, leaving a hole the size of the
  // batch interval.
  const floor = before.length ? before[before.length - 1]!.t + gridMs : points[0]!.t;
  const start = Math.min(floor, points[0]!.t);
  const end = points[points.length - 1]!.t;
  const span = end - start;
  if (span <= 0) return points.map(p => ({ ...p }));

  // Keep the output bounded: a pathological input must not produce an
  // unbounded stream while the caller waits.
  const maxOut = 2000;
  const step = span / gridMs > maxOut ? span / maxOut : gridMs;

  // Grid times plus the original sample times. Emitting the real samples
  // exactly is worth the few extra events: it means no measured point is ever
  // displaced onto a grid slot.
  const times: number[] = [];
  for (let t = start; t < end; t += step) times.push(t);
  for (const p of points) times.push(p.t);
  times.push(end);
  times.sort((a, b) => a - b);

  const out: TimedPoint[] = [];
  let seg = 0;
  for (let n = 0; n < times.length; n++) {
    const t = times[n]!;
    if (n > 0 && t - times[n - 1]! < 0.01) continue;
    while (seg + 1 < all.length - 1 && all[seg + 1]!.t <= t) seg++;
    const a = all[seg]!;
    const b = all[Math.min(seg + 1, all.length - 1)]!;
    const dt = b.t - a.t;
    const s = dt <= 0 ? 1 : clamp((t - a.t) / dt, 0, 1);
    const s2 = s * s;
    const s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1;
    const h10 = s3 - 2 * s2 + s;
    const h01 = -2 * s3 + 3 * s2;
    const h11 = s3 - s2;
    const x = h00 * a.x + h10 * dt * tangents[seg]!.x + h01 * b.x + h11 * dt * tangents[seg + 1]!.x;
    const y = h00 * a.y + h10 * dt * tangents[seg]!.y + h01 * b.y + h11 * dt * tangents[seg + 1]!.y;
    out.push({
      // Clamp to the segment box. With correct tangents the Hermite cannot
      // leave it anyway; this makes "never overshoots" a property rather than
      // a hope, and it is what the regression test asserts.
      x: clamp(x, Math.min(a.x, b.x), Math.max(a.x, b.x)),
      y: clamp(y, Math.min(a.y, b.y), Math.max(a.y, b.y)),
      t,
    });
  }
  return out;
}

/** Fritsch-Carlson tangents for a 2D sequence, applied per axis. */
function monotoneTangents(p: TimedPoint[]): Point[] {
  const n = p.length;
  const d: Point[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dt = p[i + 1]!.t - p[i]!.t;
    d.push(dt > 0
      ? { x: (p[i + 1]!.x - p[i]!.x) / dt, y: (p[i + 1]!.y - p[i]!.y) / dt }
      : { x: 0, y: 0 });
  }
  const m: Point[] = [];
  for (let i = 0; i < n; i++) {
    if (i === 0) m.push({ ...d[0]! });
    else if (i === n - 1) m.push({ ...d[n - 2]! });
    else m.push({ x: (d[i - 1]!.x + d[i]!.x) / 2, y: (d[i - 1]!.y + d[i]!.y) / 2 });
  }
  for (let i = 0; i < n - 1; i++) {
    for (const axis of ['x', 'y'] as const) {
      const delta = d[i]![axis];
      if (delta === 0) { m[i]![axis] = 0; m[i + 1]![axis] = 0; continue; }
      const a = m[i]![axis] / delta;
      const b = m[i + 1]![axis] / delta;
      const sum = a * a + b * b;
      if (sum > 9) {
        const k = 3 / Math.sqrt(sum);
        m[i]![axis] = k * a * delta;
        m[i + 1]![axis] = k * b * delta;
      }
    }
  }
  return m;
}

// ---------------------------------------------------------------- planning

export interface GestureSpec {
  kind: GestureKind;
  x?: number; y?: number;
  x1?: number; y1?: number; x2?: number; y2?: number;
  durationMs?: number;
  startDistance?: number;
  endDistance?: number;
  /** Optional polyline; when present it replaces the straight A->B path. */
  waypoints?: Point[];
  seed?: number;
  /** Lateral wobble as a fraction of path length. 0 disables it. */
  wobble?: number;
}

/** Position at fraction s of a polyline's arc length. */
export function pointAt(points: Point[], s: number): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return { ...points[0]! };
  const segs: number[] = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const d = Math.hypot(points[i + 1]!.x - points[i]!.x, points[i + 1]!.y - points[i]!.y);
    segs.push(d);
    total += d;
  }
  if (total <= 0) return { ...points[points.length - 1]! };
  let want = clamp(s, 0, 1) * total;
  for (let i = 0; i < segs.length; i++) {
    if (want <= segs[i]! || i === segs.length - 1) {
      const k = segs[i]! > 0 ? clamp(want / segs[i]!, 0, 1) : 1;
      return {
        x: points[i]!.x + (points[i + 1]!.x - points[i]!.x) * k,
        y: points[i]!.y + (points[i + 1]!.y - points[i]!.y) * k,
      };
    }
    want -= segs[i]!;
  }
  return { ...points[points.length - 1]! };
}

/**
 * Turn a gesture intent into a sampled trajectory.
 *
 * Position follows the minimum-jerk curve, so speed peaks near the middle and
 * collapses at both ends — the shape the panel measurement showed.
 */
export function planGesture(spec: GestureSpec): GesturePlan {
  const random = seededRandom(spec.seed ?? 0x9e3779b9);

  if (spec.kind === 'tap' || spec.kind === 'longPress') {
    // Measured with a real finger on this panel: 70-108 ms.
    const holdMs = spec.kind === 'longPress'
      ? clamp(Math.round(spec.durationMs ?? 700), 400, 3000)
      : 65 + Math.floor(random() * 55);
    return {
      kind: spec.kind,
      durationMs: holdMs,
      holdMs,
      samples: [{ t: 0, points: [{ id: 0, x: spec.x ?? 0, y: spec.y ?? 0 }] }],
    };
  }

  if (spec.kind === 'pinch') {
    const durationMs = clamp(Math.round(spec.durationMs ?? 300), 100, 5000);
    const cx = spec.x ?? 0;
    const cy = spec.y ?? 0;
    const start = spec.startDistance ?? 100;
    const end = spec.endDistance ?? 400;
    const samples: GestureSample[] = [];
    for (let t = 0; t <= durationMs; t += GRID_MS) {
      const d = start + (end - start) * minJerk(t / durationMs);
      samples.push({
        t: Math.min(t, durationMs),
        points: [
          { id: 0, x: cx - d / 2, y: cy },
          { id: 1, x: cx + d / 2, y: cy },
        ],
      });
    }
    return { kind: 'pinch', durationMs, samples };
  }

  const durationMs = clamp(Math.round(spec.durationMs ?? 350), 100, 5000);
  const path: Point[] = spec.waypoints?.length
    ? spec.waypoints
    : [{ x: spec.x1 ?? 0, y: spec.y1 ?? 0 }, { x: spec.x2 ?? 0, y: spec.y2 ?? 0 }];

  // A finger does not travel a mathematically straight line. The deviation is
  // tiny (1% of the path, at most 6 px) and seeded, so it is reproducible.
  const length = Math.hypot(
    path[path.length - 1]!.x - path[0]!.x,
    path[path.length - 1]!.y - path[0]!.y,
  );
  const amp = spec.wobble === 0 ? 0 : Math.min(6, length * (spec.wobble ?? 0.01));
  const signed = amp * (random() * 2 - 1);
  // Unit normal of the chord, so the wobble is perpendicular to travel.
  const nx = -(path[path.length - 1]!.y - path[0]!.y);
  const ny = path[path.length - 1]!.x - path[0]!.x;
  const nlen = Math.hypot(nx, ny) || 1;

  const samples: GestureSample[] = [];
  for (let t = 0; t <= durationMs; t += GRID_MS) {
    const at = Math.min(t, durationMs);
    const s = minJerk(at / durationMs);
    const base = pointAt(path, s);
    // sin(pi*s) vanishes at both ends, so start and end stay exact.
    const off = Math.sin(Math.PI * s) * signed;
    samples.push({
      t: at,
      points: [{ id: 0, x: base.x + (nx / nlen) * off, y: base.y + (ny / nlen) * off }],
    });
  }
  return { kind: spec.kind, durationMs, samples };
}
