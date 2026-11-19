import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globalPoint, viewScale, wheelDirection, type View } from '../src/input.js';

test('a window shown at full size maps image pixels to its place on the display', () => {
  const view: View = { originX: 900, originY: 80, scale: viewScale(900, 760, 1280), label: 'w' };
  assert.equal(view.scale, 1);
  assert.equal(globalPoint(view, 113, 203), '1013,283');
});

test('a downscaled screen maps image pixels back to display points', () => {
  const view: View = { originX: 0, originY: 0, scale: viewScale(1920, 1080, 1280), label: 's' };
  assert.equal(view.scale, 1.5);
  assert.equal(globalPoint(view, 640, 360), '960,540');
  // A tall area is scaled by its height.
  assert.equal(viewScale(800, 2560, 1280), 2);
});

test('a region keeps its offset when scaled', () => {
  const view: View = { originX: 100, originY: 50, scale: 2, label: 'r' };
  assert.equal(globalPoint(view, 10, 20), '120,90');
});

test('scroll direction is the way the agent wants to see, the opposite of the content movement Peekaboo names', () => {
  assert.equal(wheelDirection('down'), 'up');
  assert.equal(wheelDirection('up'), 'down');
  assert.equal(wheelDirection('left'), 'right');
  assert.equal(wheelDirection('sideways'), undefined);
});
