import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GRID_MS, planGesture, resample, seededRandom, type TimedPoint} from '../src/gesture-plan.js';

const dist = (a: {x: number; y: number}, b: {x: number; y: number}) => Math.hypot(b.x - a.x, b.y - a.y);

/** Largest direction change between consecutive velocity vectors, in radians. */
function maxTurn(points: TimedPoint[]) {
  let worst = 0;
  let prev: {x: number; y: number} | null = null;
  for (let i = 1; i < points.length; i++) {
    const dt = points[i]!.t - points[i - 1]!.t;
    if (dt <= 0) continue;
    const v = {x: (points[i]!.x - points[i - 1]!.x) / dt, y: (points[i]!.y - points[i - 1]!.y) / dt};
    if (prev) {
      const a = Math.hypot(prev.x, prev.y);
      const b = Math.hypot(v.x, v.y);
      if (a > 1e-6 && b > 1e-6) {
        const cos = Math.min(1, Math.max(-1, (prev.x * v.x + prev.y * v.y) / (a * b)));
        worst = Math.max(worst, Math.acos(cos));
      }
    }
    prev = v;
  }
  return worst;
}

/** Plain linear interpolation on the same grid, for comparison only. */
function linear(points: TimedPoint[], gridMs = GRID_MS): TimedPoint[] {
  const out: TimedPoint[] = [];
  const start = points[0]!.t;
  const end = points[points.length - 1]!.t;
  let seg = 0;
  for (let t = start; t <= end; t += gridMs) {
    while (seg + 2 < points.length && points[seg + 1]!.t < t) seg++;
    const a = points[seg]!, b = points[seg + 1]!;
    const k = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
    out.push({t, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k});
  }
  return out;
}

/** Points along a circle, 16 ms apart — a curve whose chords change direction. */
function circleSamples(n = 24, gapMs = 16): TimedPoint[] {
  return Array.from({length: n}, (_, i) => {
    const a = (i / (n - 1)) * Math.PI * 1.2;
    return {t: i * gapMs, x: 500 + Math.cos(a) * 300, y: 800 + Math.sin(a) * 300};
  });
}

test('resampling passes through every measured point exactly', () => {
  const input = circleSamples();
  const out = resample(input);
  for (const p of input) {
    const hit = out.find(q => Math.abs(q.t - p.t) < 0.001);
    assert.ok(hit, `no output sample at t=${p.t}`);
    assert.ok(dist(hit!, p) < 0.001, `point at t=${p.t} moved by ${dist(hit!, p)}`);
  }
});

test('resampling never leaves the box spanned by the surrounding samples', () => {
  const out = resample(circleSamples());
  for (const q of out) {
    // Every output point must sit inside the hull of its two nearest inputs.
    let i = 0;
    while (i + 2 < circleSamples().length && circleSamples()[i + 1]!.t < q.t) i++;
    const a = circleSamples()[i]!, b = circleSamples()[i + 1]!;
    assert.ok(q.x >= Math.min(a.x, b.x) - 1e-6 && q.x <= Math.max(a.x, b.x) + 1e-6, `x=${q.x} outside [${a.x},${b.x}]`);
    assert.ok(q.y >= Math.min(a.y, b.y) - 1e-6 && q.y <= Math.max(a.y, b.y) + 1e-6, `y=${q.y} outside [${a.y},${b.y}]`);
  }
});

test('resampling preserves gesture duration', () => {
  const input = circleSamples();
  const out = resample(input);
  assert.equal(out[0]!.t, input[0]!.t);
  assert.equal(out[out.length - 1]!.t, input[input.length - 1]!.t);
});

test('cubic resampling turns more smoothly than linear interpolation', () => {
  const input = circleSamples();
  const cubicTurn = maxTurn(resample(input));
  const linearTurn = maxTurn(linear(input));
  // Linear cuts a corner at every one of the 23 input points.
  assert.ok(linearTurn > 0.05, `expected linear to show corners, got ${linearTurn}`);
  assert.ok(cubicTurn < linearTurn / 2, `cubic ${cubicTurn} not clearly smoother than linear ${linearTurn}`);
});

test('a batch seam is smooth only when the previous samples are supplied', () => {
  const input = circleSamples(40);
  const head = input.slice(0, 20);
  const tail = input.slice(20);
  const withoutContext = resample(tail);
  const withContext = resample(tail, GRID_MS, head);
  // The seam is the first step of the tail batch.
  const seam = (pts: TimedPoint[]) => {
    const before = head[head.length - 1]!;
    const a = pts[0]!, b = pts[1]!;
    return Math.abs(Math.atan2(b.y - a.y, b.x - a.x) - Math.atan2(a.y - before.y, a.x - before.x));
  };
  assert.ok(seam(withContext) < seam(withoutContext), 'context did not reduce the seam discontinuity');
});

test('a planned swipe uses a bell-shaped speed profile with exact endpoints', () => {
  const plan = planGesture({kind: 'swipe', x1: 100, y1: 1800, x2: 100, y2: 400, durationMs: 400, seed: 7});
  const pts = plan.samples.map(s => s.points[0]!);
  assert.equal(pts[0]!.x, 100);
  assert.equal(pts[0]!.y, 1800);
  assert.ok(Math.abs(pts[pts.length - 1]!.y - 400) < 0.001, 'end point drifted');
  assert.equal(plan.durationMs, 400);
  assert.ok(plan.samples.length >= 400 / GRID_MS, 'too few samples');

  const steps = pts.slice(1).map((p, i) => dist(p, pts[i]!));
  const peak = Math.max(...steps);
  const peakAt = steps.indexOf(peak) / steps.length;
  assert.ok(peakAt > 0.35 && peakAt < 0.65, `peak at ${(peakAt * 100).toFixed(0)}%`);
  assert.ok(steps[0]! < peak / 5, 'start is not slow');
  assert.ok(steps[steps.length - 1]! < peak / 5, 'end is not slow');
});

test('a tap holds for a realistic duration and is reproducible from its seed', () => {
  const a = planGesture({kind: 'tap', x: 10, y: 20, seed: 3});
  const b = planGesture({kind: 'tap', x: 10, y: 20, seed: 3});
  const c = planGesture({kind: 'tap', x: 10, y: 20, seed: 4});
  assert.deepEqual(a, b);
  assert.ok(a.holdMs! >= 65 && a.holdMs! <= 119, `hold ${a.holdMs}`);
  assert.notEqual(a.holdMs, c.holdMs);
  assert.equal(a.samples.length, 1);
});

test('the wobble stays small and does not move the endpoints', () => {
  const plan = planGesture({kind: 'swipe', x1: 0, y1: 0, x2: 0, y2: 1000, durationMs: 300, seed: 11});
  const xs = plan.samples.map(s => s.points[0]!.x);
  assert.ok(Math.max(...xs.map(Math.abs)) <= 6.0001, 'wobble exceeded 6 px');
  assert.ok(Math.max(...xs.map(Math.abs)) > 0, 'wobble was not applied');
  assert.equal(plan.samples[0]!.points[0]!.x, 0);
  assert.ok(Math.abs(plan.samples[plan.samples.length - 1]!.points[0]!.x) < 1e-9);
});

test('waypoints shape the path instead of a straight line', () => {
  const plan = planGesture({
    kind: 'drag',
    waypoints: [{x: 0, y: 0}, {x: 400, y: 0}, {x: 400, y: 400}],
    durationMs: 400,
    seed: 1,
    wobble: 0,
  });
  const pts = plan.samples.map(s => s.points[0]!);
  // The corner at (400,0) must be visited: max x is reached before max y.
  const maxX = Math.max(...pts.map(p => p.x));
  assert.ok(Math.abs(maxX - 400) < 0.001);
  const firstAtMaxX = pts.findIndex(p => Math.abs(p.x - 400) < 0.001);
  assert.ok(pts[firstAtMaxX]!.y < 10, 'corner was cut');
});

test('pinch moves both pointers symmetrically and monotonically', () => {
  const plan = planGesture({kind: 'pinch', x: 540, y: 1200, startDistance: 100, endDistance: 400, durationMs: 300});
  const first = plan.samples[0]!.points;
  const last = plan.samples[plan.samples.length - 1]!.points;
  assert.equal(first.length, 2);
  assert.ok(Math.abs((last[1]!.x - last[0]!.x) - 400) < 0.001);
  let prev = -Infinity;
  for (const s of plan.samples) {
    const d = s.points[1]!.x - s.points[0]!.x;
    assert.ok(d >= prev - 1e-6, 'separation is not monotonic');
    prev = d;
  }
});

test('the seeded generator is stable across calls', () => {
  const a = seededRandom(42);
  const b = seededRandom(42);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
});
