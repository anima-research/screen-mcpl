import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WatchManager, classify, type Burst, type WatchSpec } from '../src/watch.js';
import type { KeptFrame, LiveOptions, LiveSession } from '../src/peekaboo.js';

/** A fake `capture live`: the test pushes frames in by hand and ends segments on demand. */
function fakeLive() {
  let onFrame: ((f: KeptFrame) => void) | null = null;
  let finish: ((ok: boolean, error?: { code?: string; message?: string }) => void) | null = null;
  let index = 0;
  const sessions: LiveOptions[] = [];
  const startLive = (o: LiveOptions, cb: (f: KeptFrame) => void): LiveSession => {
    sessions.push(o);
    onFrame = cb;
    index = 0;
    const done = new Promise<import('../src/peekaboo.js').LiveOutcome>((resolve) => {
      finish = (ok, error) => resolve({ ok, error, exitCode: ok ? 0 : 1, signal: null, stats: ok ? { framesKept: index } : undefined });
    });
    return { pid: 1, done, stop() { finish?.(true); } };
  };
  return {
    startLive,
    sessions,
    frame() { index += 1; onFrame!({ index, path: `/fake/keep-${index}.png`, at: Date.now() }); },
    end(ok = true, error?: { code?: string; message?: string }) { finish!(ok, error); },
  };
}

function spec(over: Partial<WatchSpec> = {}): WatchSpec {
  return { id: 'w', label: 'W', target: { app: 'Finder' }, threshold: 2.5, coalesceSeconds: 0.15, maxHoldSeconds: 0.6, minIntervalSeconds: 0,
    image: 'none', highlight: true, maxPx: 800, paused: false, createdAt: 0, ...over };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test('baseline is not a change; burst coalesces into one push with the last frame', async () => {
  const live = fakeLive();
  const pushes: Burst[] = [];
  const states: string[] = [];
  const m = new WatchManager(mkdtempSync(join(tmpdir(), 'smcpl-')), {
    push: async (_s, _rt, b) => { pushes.push(b); return true; },
    stateChanged: (_s, rt) => states.push(rt.state), log: () => {},
  }, { startLive: live.startLive, renderFrame: async (_src, out) => ({ path: out, bytes: 1 }) });
  const first = m.start(spec());
  await sleep(10);
  live.frame(); // baseline
  assert.deepEqual(await first, { ok: true });
  assert.equal(m.get('w')!.rt.state, 'watching');
  live.frame(); await sleep(50); live.frame(); await sleep(50); live.frame();
  assert.equal(pushes.length, 0, 'nothing pushed while the burst is still active');
  await sleep(250);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].frames.length, 3);
  assert.equal(pushes[0].frames.at(-1)!.index, 4);
  assert.equal(m.get('w')!.rt.changes, 3);
  assert.equal(m.get('w')!.rt.pushes, 1);
  m.stopAll();
});

test('continuous activity still pushes by maxHoldSeconds', async () => {
  const live = fakeLive();
  const pushes: Burst[] = [];
  const m = new WatchManager(mkdtempSync(join(tmpdir(), 'smcpl-')), {
    push: async (_s, _rt, b) => { pushes.push(b); return true; }, stateChanged: () => {}, log: () => {},
  }, { startLive: live.startLive });
  const first = m.start(spec({ coalesceSeconds: 0.2, maxHoldSeconds: 0.5 }));
  await sleep(10); live.frame(); await first;
  const t0 = Date.now();
  while (Date.now() - t0 < 900) { live.frame(); await sleep(60); }
  assert.ok(pushes.length >= 1 && pushes.length <= 2, `expected 1–2 pushes under continuous change, got ${pushes.length}`);
  m.stopAll();
});

test('segments chain back-to-back; each segment baseline is skipped', async () => {
  const live = fakeLive();
  const pushes: Burst[] = [];
  const m = new WatchManager(mkdtempSync(join(tmpdir(), 'smcpl-')), {
    push: async (_s, _rt, b) => { pushes.push(b); return true; }, stateChanged: () => {}, log: () => {},
  }, { startLive: live.startLive });
  const first = m.start(spec());
  await sleep(10); live.frame(); await first;
  live.end(true);
  await sleep(20);
  assert.equal(live.sessions.length, 2, 'second segment started');
  assert.equal(m.get('w')!.rt.segment, 2);
  live.frame(); // new segment's baseline
  await sleep(250);
  assert.equal(pushes.length, 0, 'segment baseline must not wake');
  live.frame();
  await sleep(250);
  assert.equal(pushes.length, 1);
  m.stopAll();
});

test('app gone → waiting state + stateChanged; first-outcome reports it', async () => {
  const live = fakeLive();
  const states: string[] = [];
  const m = new WatchManager(mkdtempSync(join(tmpdir(), 'smcpl-')), {
    push: async () => true, stateChanged: (_s, rt) => states.push(rt.state), log: () => {},
  }, { startLive: live.startLive });
  const first = m.start(spec());
  await sleep(10);
  live.end(false, { code: 'APP_NOT_FOUND', message: 'Application not found: Finder' });
  const r = await first;
  assert.equal(r.ok, false);
  assert.equal((r as { state: string }).state, 'waiting');
  assert.deepEqual(states, ['waiting']);
  m.stopAll();
});

test('classify maps peekaboo errors', () => {
  assert.equal(classify({ code: 'PERMISSION_ERROR_SCREEN_RECORDING', message: 'x' }, {}, 1).state, 'blocked');
  assert.equal(classify({ code: 'CAPTURE_FAILED', message: 'Screen capture is unavailable while the macOS GUI session is locked.' }, {}, 1).state, 'blocked');
  assert.equal(classify({ code: 'WINDOW_NOT_FOUND', message: 'no window' }, { app: 'X' }, 1).state, 'waiting');
  assert.equal(classify({ code: 'WEIRD', message: 'boom' }, {}, 7).retryMs, 7);
});

test('restart never reuses a segment directory', async () => {
  const live = fakeLive();
  const root = mkdtempSync(join(tmpdir(), 'smcpl-'));
  const m = new WatchManager(root, { push: async () => true, stateChanged: () => {}, log: () => {} }, { startLive: live.startLive });
  const f1 = m.start(spec()); await sleep(10); live.frame(); await f1;
  const d1 = live.sessions[0].dir;
  m.stopAll();
  const m2 = new WatchManager(root, { push: async () => true, stateChanged: () => {}, log: () => {} }, { startLive: live.startLive });
  const f2 = m2.start(spec()); await sleep(10); live.frame(); await f2;
  assert.notEqual(live.sessions[1].dir, d1);
  m2.stopAll();
});
