/**
 * Utility functions and data structures for the whiteboard application
 * @module utils
 */

/**
 * Generate a unique ID
 * @returns {string} Unique ID
 */
export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/**
 * Generate HSL color from seed
 * @param {string} seed
 * @returns {string} HSL color string
 */
export function hslColor(seed) {
  let h = 0;
  for (const c of String(seed || '')) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 65% 55%)`;
}

/**
 * Clamp value between min and max
 * @param {number} v
 * @param {number} a
 * @param {number} b
 * @returns {number} Clamped value
 */
export function clamp(v, a, b) {
  return v < a ? a : (v > b ? b : v);
}

/**
 * Round world coordinate to 2 decimal places to keep serialized JSON compact
 * @param {number} n
 * @returns {number}
 */
export function roundCoord(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Deep copy an object safely
 * @param {any} o
 * @returns {any} Copied object
 */
export function deepCopy(o) {
  if (o === null || typeof o !== 'object') return o;
  return JSON.parse(JSON.stringify(o));
}

/**
 * Convert screen coordinates to world coordinates
 * @param {number} sx
 * @param {number} sy
 * @param {{x: number, y: number, scale: number}} view
 * @returns {{x: number, y: number}} World coordinates {x, y}
 */
export function screenToWorld(sx, sy, view) {
  return { x: (sx - view.x) / view.scale, y: (sy - view.y) / view.scale };
}

/**
 * Convert world coordinates to screen coordinates
 * @param {number} wx
 * @param {number} wy
 * @param {{x: number, y: number, scale: number}} view
 * @returns {{x: number, y: number}} Screen coordinates {x, y}
 */
export function worldToScreen(wx, wy, view) {
  return { x: wx * view.scale + view.x, y: wy * view.scale + view.y };
}

/**
 * Show a toast message
 * @param {string} msg
 * @param {number} [duration=1600]
 */
export function toast(msg, duration = 1600) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    t.style.opacity = '0';
  }, duration);
}

/**
 * Bounded FIFO Set that evicts the oldest entries when capacity is exceeded,
 * avoiding full-clear spikes (`seen.clear()`) that cause message echo storms.
 */
export class BoundedSet {
  /**
   * @param {number} [maxSize=4000]
   */
  constructor(maxSize = 4000) {
    this.maxSize = maxSize;
    this._set = new Set();
  }

  has(item) {
    return this._set.has(item);
  }

  add(item) {
    if (this._set.has(item)) {
      // Refresh insertion order
      this._set.delete(item);
      this._set.add(item);
      return this;
    }
    this._set.add(item);
    while (this._set.size > this.maxSize) {
      const oldest = this._set.values().next().value;
      this._set.delete(oldest);
    }
    return this;
  }

  delete(item) {
    return this._set.delete(item);
  }

  clear() {
    this._set.clear();
  }

  get size() {
    return this._set.size;
  }
}
