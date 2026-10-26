// Does the live path actually reproduce the browser's timeline?
//
// The defect this pins down: the old replay loop slept `min(8ms, remaining)`
// between points, so any gesture sampled slower than 8 ms was delivered
// compressed — a 60 Hz browser produced a ~1.8x speed-up on the device. Because
// scrcpy stamps each injected event with its arrival time, a compressed replay
// is a compressed gesture, and every app that measures velocity sees it.
//
// This test plays a browser: it emits batches with the cadence and sample
// spacing the page now uses, records what the device channel received, and
// checks the delivered timeline against the intended one.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Device} from '../src/device.js';
import {TouchControl} from '../src/touch-control.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface Sent { action: number; id: number; x: number; y: number; at: number }

function fixture() {
  const device = new Device('fixture', 'unused', 'unused');
  const sent: Sent[] = [];
  Object.assign(device.state, {screenOn: true, locked: false, powerCollectedAt: Date.now(), controlAvailable: true});
  device.video.width = 864;
  device.video.height = 1920;
  device.video.client = {
    controller: {
      injectTouch: async (p: any) => { sent.push({action: p.action, id: Number(p.pointerId), x: p.pointerX, y: p.pointerY, at: Date.now()}); },
      injectKeyCode: async () => {},
    },
  } as any;
  device.bridge.call = async () => { assert.fail('real-time touch must not wait on native UI queries'); };
  const replies: any[] = [];
  const stream = new TouchControl(device, 'owner', data => replies.push(data));
  return {device, sent, replies, stream};
}

test('a 400 ms drag reaches the device in 400 ms, not compressed', async () => {
  const f = fixture();
  const gesture = randomUUID();
  const width = 864, height = 1920;

  // What the page sends: one sample per 16 ms, one batch per 32 ms.
  const samples = Array.from({length: 26}, (_, i) => ({t: i * 16, x: 400, y: 1700 - i * 40}));
  const batches: typeof samples[] = [];
  for (let i = 0; i < samples.length; i += 2) batches.push(samples.slice(i, i + 2));

  f.stream.receive({type: 'touch', gesture, seq: 0, action: 0, id: 10, x: 400, y: 1700, t: 0, width, height});
  let seq = 1;
  const started = Date.now();
  for (const batch of batches) {
    if (batch[0]!.t > 0) await sleep(Math.max(0, started + batch[0]!.t - Date.now()));
    f.stream.receive({type: 'touch-move', gesture, seq, width, height, points: batch.map(s => ({id: 10, ...s}))});
    seq += batch.length;
  }
  const last = samples[samples.length - 1]!;
  f.stream.receive({type: 'touch', gesture, seq, action: 1, id: 10, x: last.x, y: last.y, t: last.t, width, height});
  await f.stream.drain();

  const moves = f.sent.filter(p => p.action === 2);
  const up = f.sent.filter(p => p.action === 1);
  assert.equal(up.length, 1);

  // 1. Duration is preserved: the browser's 400 ms of finger time took ~400 ms.
  const playedMs = moves[moves.length - 1]!.at - moves[0]!.at;
  const ratio = playedMs / 400;
  assert.ok(ratio > 0.9 && ratio < 1.15, `compressed: ${playedMs} ms for a 400 ms gesture (x${ratio.toFixed(2)})`);

  // 2. Density matches the panel: a 4 ms grid over 400 ms is ~100 injections,
  //    far more than the 25 the browser sent.
  assert.ok(moves.length >= 90, `only ${moves.length} move injections`);

  // 3. No bursts: consecutive injections are at least ~1 ms apart and none gapes.
  let maxGap = 0;
  for (let i = 1; i < moves.length; i++) maxGap = Math.max(maxGap, moves[i]!.at - moves[i - 1]!.at);
  assert.ok(maxGap <= 40, `injection stalled for ${maxGap} ms`);

  // 4. Every measured point survived: interpolation never replaces the real ones.
  const seen = new Set(moves.map(m => `${m.x},${m.y}`));
  for (const s of samples.slice(1)) {
    assert.ok(seen.has(`${s.x},${s.y}`), `measured point ${s.x},${s.y} was dropped`);
  }

  // 5. The path is monotonic in y (a straight drag) — no overshoot.
  for (let i = 1; i < moves.length; i++) assert.ok(moves[i]!.y <= moves[i - 1]!.y, 'y overshot');

  // 6. Nothing was reported as compressed.
  const acks = f.replies.filter(r => r.type === 'ack');
  assert.equal(acks.some(a => a.compressedMs), false);
});

test('a slow injection rate is reported rather than silently compressed', async () => {
  const f = fixture();
  const gesture = randomUUID();
  // Make each injection take longer than the grid step.
  (f.device.video.client as any).controller.injectTouch = async (p: any) => {
    await sleep(6);
  };
  f.stream.receive({type: 'touch', gesture, seq: 0, action: 0, id: 10, x: 10, y: 10, t: 0, width: 864, height: 1920});
  f.stream.receive({type: 'touch-move', gesture, seq: 1, width: 864, height: 1920,
    points: [{id: 10, x: 10, y: 100, t: 0}, {id: 10, x: 10, y: 200, t: 80}]});
  await f.stream.drain();
  const ack = f.replies.filter(r => r.type === 'ack').at(-1);
  assert.ok(ack.compressedMs > 0, 'falling behind should be reported');
});
