import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pngSize, viewScale, windowPoint, withoutCliAdvice } from '../src/input.js';

test('a window shown at full size maps pixel for point', () => {
  const scale = viewScale(900, 700, 1280);
  assert.equal(scale, 1);
  assert.equal(windowPoint({ windowId: 1, title: 't', scale }, 113, 203), '113,203');
});

test('a downscaled window maps image pixels back to window points', () => {
  const scale = viewScale(1920, 1080, 1280);
  assert.equal(scale, 1.5);
  assert.equal(windowPoint({ windowId: 1, title: 't', scale }, 640, 360), '960,540');
  // A tall window is scaled by its height.
  assert.equal(viewScale(800, 2560, 1280), 2);
});

test('pngSize reads the IHDR dimensions', () => {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(900, 16);
  header.writeUInt32BE(700, 20);
  const p = join(mkdtempSync(join(tmpdir(), 'screen-mcpl-')), 'a.png');
  writeFileSync(p, header);
  assert.deepEqual(pngSize(p), { width: 900, height: 700 });
});

test('the foreground CLI advice is dropped from a failed background click', () => {
  const msg = 'No pressable accessibility element was found at (125, 323) in PID 1. Background clicks press the accessibility element at the target point, and nothing pressable was found there — the point may be empty. Re-run with --foreground --input-strategy synthOnly to focus the app and send a real mouse click at these coordinates.';
  const out = withoutCliAdvice(msg);
  assert.ok(out.endsWith('the point may be empty.'));
  assert.ok(!out.includes('--foreground'));
  assert.equal(withoutCliAdvice('Typing failed.'), 'Typing failed.');
});
