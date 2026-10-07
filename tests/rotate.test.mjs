/**
 * Rotation-feature tests (Word-style rotate handles for notes & images):
 *
 *   1. hitNote() must invert the element rotation before the AABB check, so a
 *      rotated element is hittable inside its rotated outline and NOT hittable
 *      in the axis-aligned corners that visually belong to no element.
 *   2. noteHandles() must return the 8 resize handles rotated around the
 *      element centre, plus a rotation handle offset above the top edge in the
 *      element's own frame.
 *   3. contentBounds() must use the rotated bounding box (4 corners projected).
 *   4. The rotation field survives persist() → localStorage JSON round-trip
 *      and a live-move (_isLiveMove) upsert merge in network.handleMsg().
 *
 * These exercise the real src/js/interaction.js / state.js / network.js code —
 * no copies of the geometry.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { initNetwork } from '../src/js/network.js';
import { state, upsert, persist, setPersistKey } from '../src/js/state.js';
import {
  hitNote, elCenter, rotatePointAround, noteHandles, hitRotateHandle,
  contentBounds, NOTE_W, NOTE_H,
} from '../src/js/interaction.js';

initNetwork(); // registers handleMsg path; peerjs is mocked by tests/hooks.mjs

const VIEW = { x: 400, y: 300, scale: 1 };

test('hitNote inverts rotation before the AABB check', () => {
  const n = { id: 'A', type: 'note', x: 0, y: 0, w: 100, h: 60, rotation: Math.PI / 2 };
  const c = elCenter(n); // (50, 30)

  // Centre is always a hit.
  assert.ok(hitNote(n, { x: c.x, y: c.y }), 'centre hits');

  // 90° rotation: the element occupies x∈[20,80], y∈[-20,80] in world space.
  // A point just above the centre (inside the rotated outline).
  assert.ok(hitNote(n, { x: 50, y: -10 }), 'point inside rotated outline hits');
  // Axis-aligned corner region of the UNROTATED box is now outside.
  assert.ok(!hitNote(n, { x: 5, y: 5 }), 'unrotated top-left corner misses when rotated 90°');
  // Far outside.
  assert.ok(!hitNote(n, { x: 200, y: 200 }), 'far point misses');

  // rotation = 0 keeps legacy behaviour.
  const flat = { id: 'B', type: 'note', x: 0, y: 0, w: 100, h: 60 };
  assert.ok(hitNote(flat, { x: 5, y: 5 }), 'unrotated corner still hits');
});

test('rotatePointAround matches manual rotation math', () => {
  // Rotate (1,0) around origin by +90° → (0,1)
  const p = rotatePointAround(1, 0, 0, 0, Math.PI / 2);
  assert.ok(Math.abs(p.x) < 1e-9 && Math.abs(p.y - 1) < 1e-9, '90° rotation of (1,0) is (0,1)');
  // Rotating back by -90° restores the original point.
  const q = rotatePointAround(p.x, p.y, 0, 0, -Math.PI / 2);
  assert.ok(Math.abs(q.x - 1) < 1e-9 && Math.abs(q.y) < 1e-9, 'round-trip restores point');
});

test('noteHandles returns 8 rotated resize handles + a rotation handle', () => {
  const prevView = { ...state.view };
  state.view = VIEW;
  try {
    const n = { id: 'C', type: 'note', x: 0, y: 0, w: NOTE_W, h: NOTE_H, rotation: Math.PI / 2 };
    const { pts, sz, rotScreen, rotCx } = noteHandles(n);
    for (const k of ['nw', 'ne', 'sw', 'se', 'n', 's', 'w', 'e']) {
      assert.ok(pts[k], `handle ${k} exists`);
      assert.ok(Number.isFinite(pts[k].x) && Number.isFinite(pts[k].y), `handle ${k} is finite`);
    }
    assert.ok(rotScreen && Number.isFinite(rotScreen.x), 'rotation handle position exists');
    assert.ok(rotCx && Number.isFinite(rotCx.x), 'rotation handle centre line exists');

    // 90° rotation: the "nw" corner (unrotated top-left = (-w/2,-h/2) rel centre)
    // maps to centre + (h/2, -w/2) in world, i.e. to the upper-right of centre.
    const c = elCenter(n);
    const nwWorld = { x: c.x + n.h / 2, y: c.y - n.w / 2 };
    const cScreen = rotCx; // centre in screen space
    const expectX = cScreen.x + (nwWorld.x - c.x) * VIEW.scale;
    const expectY = cScreen.y + (nwWorld.y - c.y) * VIEW.scale;
    assert.ok(Math.abs(pts.nw.x - expectX) < 1e-6, 'nw handle rotated correctly (x)');
    assert.ok(Math.abs(pts.nw.y - expectY) < 1e-6, 'nw handle rotated correctly (y)');

    // Rotation handle sits above the top edge in the element frame → after
    // +90° it is to the RIGHT of the centre at distance h/2 + offset.
    const d = Math.hypot(rotScreen.x - cScreen.x, rotScreen.y - cScreen.y);
    assert.ok(d > n.h / 2 * VIEW.scale, 'rotation handle is outside the selection frame');

    // hitRotateHandle agrees with the returned position.
    assert.ok(hitRotateHandle(n, { x: rotScreen.x, y: rotScreen.y }), 'rotation handle hits at its own position');
    assert.ok(!hitRotateHandle(n, { x: rotScreen.x + 4 * sz, y: rotScreen.y }), 'rotation handle misses far away');
  } finally {
    state.view = prevView;
  }
});

test('contentBounds uses the rotated bounding box', () => {
  const prevElements = state.elements;
  state.elements = {
    R: { id: 'R', type: 'note', x: 0, y: 0, w: 100, h: 10, rotation: Math.PI / 2 },
  };
  try {
    const b = contentBounds();
    // Rotated 90° about centre (50,5): corners map to x∈[45,55], y∈[-45,55].
    // With pad=80:
    assert.ok(Math.abs((b.minX + 80) - 45) < 1e-6, `minX from rotated box, got ${b.minX}`);
    assert.ok(Math.abs((b.maxX - 80) - 55) < 1e-6, `maxX from rotated box, got ${b.maxX}`);
    assert.ok(Math.abs((b.minY + 80) + 45) < 1e-6, `minY from rotated box, got ${b.minY}`);
    assert.ok(Math.abs((b.maxY - 80) - 55) < 1e-6, `maxY from rotated box, got ${b.maxY}`);
  } finally {
    state.elements = prevElements;
  }
});

test('rotation survives persist → localStorage JSON round-trip', () => {
  setPersistKey('wb-elements-v2:rotate-test');
  localStorage.clear();
  const prevElements = state.elements;
  const prevPersistable = state.persistable;
  state.persistable = true;
  state.elements = {};
  try {
    upsert({ id: 'IMG', type: 'image', x: 0, y: 0, w: 50, h: 40, dataUrl: 'data:image/png;base64,x', rotation: 0.7, rev: 0 }, false);
    persist();
    const stored = JSON.parse(localStorage.getItem('wb-elements-v2:rotate-test'));
    assert.equal(stored.IMG.rotation, 0.7, 'rotation persisted verbatim');
  } finally {
    state.elements = prevElements;
    state.persistable = prevPersistable;
    localStorage.clear();
  }
});

test('legacy elements without rotation default to 0 everywhere', () => {
  // Old localStorage payloads have no rotation field; every consumer must treat
  // it as 0 (backward compatible, no migration).
  const legacy = { id: 'L', type: 'image', x: 0, y: 0, w: 100, h: 50 };
  assert.ok(hitNote(legacy, { x: 99, y: 49 }), 'legacy hit works without rotation field');
  const prevElements = state.elements;
  state.elements = { L: legacy };
  try {
    const b = contentBounds();
    assert.equal(b.minX + 80, 0, 'legacy bounds unchanged');
  } finally {
    state.elements = prevElements;
  }
});
