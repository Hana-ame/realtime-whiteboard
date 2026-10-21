/**
 * Pure 2D geometry, spatial hit-testing, and bounding-box calculations.
 * Decoupled from DOM events so both renderer and interaction layers can import it cleanly.
 * @module geometry
 */

import { state } from './state.js';
import { clamp, worldToScreen, roundCoord } from './utils.js';

export const NOTE_W = 170;
export const NOTE_H = 120;
export const ROTATE_OFFSET = 28;

/**
 * Element centre in world coordinates.
 * @param {Object} n
 * @returns {{x: number, y: number}}
 */
export function elCenter(n) {
  return { x: n.x + n.w / 2, y: n.y + n.h / 2 };
}

export const noteCenter = elCenter;

/**
 * Rotate a world point around (cx, cy) by angle (radians).
 * @param {number} px
 * @param {number} py
 * @param {number} cx
 * @param {number} cy
 * @param {number} angle
 * @returns {{x: number, y: number}}
 */
export function rotatePointAround(px, py, cx, cy, angle) {
  if (!angle) return { x: px, y: py };
  const c = Math.cos(angle), s = Math.sin(angle);
  const dx = px - cx, dy = py - cy;
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
}

/**
 * Hit-test a rectangular element (note or image), accounting for rotation.
 * @param {Object} n
 * @param {{x: number, y: number}} p
 * @returns {boolean}
 */
export function hitNote(n, p) {
  if (!n || !p) return false;
  if (n.rotation) {
    const c = elCenter(n);
    const local = rotatePointAround(p.x, p.y, c.x, c.y, -n.rotation);
    return local.x >= n.x && local.x <= n.x + n.w &&
           local.y >= n.y && local.y <= n.y + n.h;
  }
  return p.x >= n.x && p.x <= n.x + n.w && p.y >= n.y && p.y <= n.y + n.h;
}

/**
 * Distance from point p to line segment [a, b].
 * @param {{x: number, y: number}} p
 * @param {{x: number, y: number}} a
 * @param {{x: number, y: number}} b
 * @returns {number}
 */
export function distToSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = clamp(t, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Hit-test a freehand stroke against world point p.
 * @param {Object} s
 * @param {{x: number, y: number}} p
 * @returns {boolean}
 */
export function distToStroke(s, p) {
  if (!s || !Array.isArray(s.points) || s.points.length === 0) return false;
  const th = Math.max(6 / state.view.scale, (s.width || 4) / 2 + 3 / state.view.scale);
  if (s.points.length === 1) {
    return Math.hypot(p.x - s.points[0].x, p.y - s.points[0].y) < th;
  }
  for (let i = 1; i < s.points.length; i++) {
    if (distToSeg(p, s.points[i - 1], s.points[i]) < th) return true;
  }
  return false;
}

/**
 * Intersection point on rectangle boundary of element `n` along ray toward `toward`.
 * Supports rotated elements by transforming `toward` into the element's local frame.
 * @param {Object} n
 * @param {{x: number, y: number}} toward
 * @returns {{x: number, y: number}}
 */
export function rectEdgePoint(n, toward) {
  const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
  const rot = n.rotation || 0;
  const localTarget = rot ? rotatePointAround(toward.x, toward.y, cx, cy, -rot) : toward;
  const dx = localTarget.x - cx, dy = localTarget.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const hw = n.w / 2, hh = n.h / 2;
  const sx = dx !== 0 ? hw / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? hh / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  const localEdge = { x: cx + dx * s, y: cy + dy * s };
  return rot ? rotatePointAround(localEdge.x, localEdge.y, cx, cy, rot) : localEdge;
}

/**
 * Compute world endpoints {a, b} for a connection element.
 * @param {Object} c
 * @returns {{a: {x: number, y: number}, b: {x: number, y: number}}|null}
 */
export function connEndpoints(c) {
  const a = state.elements[c.from], b = state.elements[c.to];
  if (!a || !b) return null;
  const centerA = noteCenter(a);
  return { a: centerA, b: rectEdgePoint(b, centerA) };
}

/**
 * Deterministic z-order hit-test at world point `p`.
 * Priority: type rank (note > image > stroke > connection), then z descending,
 * then insertion order descending.
 * @param {{x: number, y: number}} p
 * @returns {Object|null}
 */
export function pick(p) {
  const ids = Object.keys(state.elements);
  const rank = { note: 3, image: 2, stroke: 1, connection: 0 };
  const idx = new Map(ids.map((id, i) => [id, i]));
  ids.sort((a, b) => {
    const ea = state.elements[a], eb = state.elements[b];
    if (!ea || !eb) return 0;
    const ra = rank[ea.type] ?? 0, rb = rank[eb.type] ?? 0;
    if (ra !== rb) return rb - ra;
    const za = ea.z || 0, zb = eb.z || 0;
    if (za !== zb) return zb - za;
    return idx.get(b) - idx.get(a);
  });
  for (const id of ids) {
    const el = state.elements[id];
    if (!el) continue;
    if (el.type === 'note' && hitNote(el, p)) return el;
    if (el.type === 'image' && hitNote(el, p)) return el;
    if (el.type === 'stroke' && distToStroke(el, p)) return el;
    if (el.type === 'connection') {
      const e = connEndpoints(el);
      if (e && distToSeg(p, e.a, e.b) < 7 / state.view.scale) return el;
    }
  }
  return null;
}

/**
 * Compute screen-space positions for 8 resize handles and 1 rotation handle.
 * @param {Object} n
 * @returns {{pts: Record<string, {x: number, y: number}>, sz: number, rotScreen: {x: number, y: number}, rotCx: {x: number, y: number}}}
 */
export function noteHandles(n) {
  const c = elCenter(n);
  const sc = state.view.scale;
  const sz = 8;

  const localRel = {
    nw: { x: -n.w / 2, y: -n.h / 2 },
    ne: { x:  n.w / 2, y: -n.h / 2 },
    sw: { x: -n.w / 2, y:  n.h / 2 },
    se: { x:  n.w / 2, y:  n.h / 2 },
    n:  { x:  0,        y: -n.h / 2 },
    s:  { x:  0,        y:  n.h / 2 },
    w:  { x: -n.w / 2, y:  0 },
    e:  { x:  n.w / 2, y:  0 }
  };
  const pts = {};
  for (const k in localRel) {
    const w = rotatePointAround(c.x + localRel[k].x, c.y + localRel[k].y, c.x, c.y, n.rotation || 0);
    pts[k] = worldToScreen(w.x, w.y, state.view);
  }

  const rotOffsetWorld = ROTATE_OFFSET / sc;
  const rotLocalRel = { x: 0, y: -n.h / 2 - rotOffsetWorld };
  const rotWorld = rotatePointAround(c.x + rotLocalRel.x, c.y + rotLocalRel.y, c.x, c.y, n.rotation || 0);
  const rotScreen = worldToScreen(rotWorld.x, rotWorld.y, state.view);
  const rotCx = worldToScreen(c.x, c.y, state.view);

  return { pts, sz, rotScreen, rotCx };
}

/**
 * Hit-test the 8 resize handles in screen space.
 * @param {Object} n
 * @param {{x: number, y: number}} p
 * @returns {string|null}
 */
export function hitHandle(n, p) {
  const { pts, sz } = noteHandles(n);
  for (const k in pts) {
    if (Math.abs(p.x - pts[k].x) <= sz && Math.abs(p.y - pts[k].y) <= sz) return k;
  }
  return null;
}

/**
 * Hit-test the rotation handle in screen space.
 * @param {Object} n
 * @param {{x: number, y: number}} p
 * @returns {boolean}
 */
export function hitRotateHandle(n, p) {
  const { rotScreen, sz } = noteHandles(n);
  return Math.abs(p.x - rotScreen.x) <= sz && Math.abs(p.y - rotScreen.y) <= sz;
}

/**
 * Compute padded world-space bounding box of all elements on the board.
 * @returns {{minX: number, minY: number, maxX: number, maxY: number}}
 */
export function contentBounds() {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, has = false;
  for (const id in state.elements) {
    const el = state.elements[id];
    if (!el) continue;
    let x0, y0, x1, y1;
    if (el.type === 'note' || el.type === 'image') {
      if (el.rotation) {
        const c = elCenter(el);
        const corners = [
          rotatePointAround(el.x, el.y, c.x, c.y, el.rotation),
          rotatePointAround(el.x + el.w, el.y, c.x, c.y, el.rotation),
          rotatePointAround(el.x, el.y + el.h, c.x, c.y, el.rotation),
          rotatePointAround(el.x + el.w, el.y + el.h, c.x, c.y, el.rotation)
        ];
        for (const corner of corners) {
          x0 = Math.min(x0 ?? corner.x, corner.x);
          y0 = Math.min(y0 ?? corner.y, corner.y);
          x1 = Math.max(x1 ?? corner.x, corner.x);
          y1 = Math.max(y1 ?? corner.y, corner.y);
        }
      } else {
        x0 = el.x; y0 = el.y; x1 = el.x + el.w; y1 = el.y + el.h;
      }
    } else if (el.type === 'stroke') {
      if (!el.points || el.points.length === 0) continue;
      for (const pt of el.points) {
        x0 = Math.min(x0 ?? pt.x, pt.x);
        y0 = Math.min(y0 ?? pt.y, pt.y);
        x1 = Math.max(x1 ?? pt.x, pt.x);
        y1 = Math.max(y1 ?? pt.y, pt.y);
      }
    } else continue;
    minX = Math.min(minX, x0);
    minY = Math.min(minY, y0);
    maxX = Math.max(maxX, x1);
    maxY = Math.max(maxY, y1);
    has = true;
  }
  if (!has) return { minX: -state.W / 2, minY: -state.H / 2, maxX: state.W / 2, maxY: state.H / 2 };
  const pad = 80;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

/**
 * Simplify a stroke's points using Ramer-Douglas-Peucker algorithm to reduce
 * P2P payload size and storage footprint while keeping visual fidelity.
 * @param {Array<{x: number, y: number}>} points
 * @param {number} [epsilon=0.8]
 * @returns {Array<{x: number, y: number}>}
 */
export function simplifyStrokePoints(points, epsilon = 0.8) {
  if (!Array.isArray(points) || points.length <= 2) {
    return (points || []).map(p => ({ x: roundCoord(p.x), y: roundCoord(p.y) }));
  }

  let maxDist = 0;
  let index = 0;
  const first = points[0];
  const last = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const d = distToSeg(points[i], first, last);
    if (d > maxDist) {
      index = i;
      maxDist = d;
    }
  }

  if (maxDist > epsilon) {
    const left = simplifyStrokePoints(points.slice(0, index + 1), epsilon);
    const right = simplifyStrokePoints(points.slice(index), epsilon);
    return left.slice(0, left.length - 1).concat(right);
  }
  return [
    { x: roundCoord(first.x), y: roundCoord(first.y) },
    { x: roundCoord(last.x), y: roundCoord(last.y) },
  ];
}
