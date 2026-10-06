/**
 * Utility functions for the whiteboard application
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
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) % 360;
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
 * Deep copy an object
 * @param {Object} o 
 * @returns {Object} Copied object
 */
export function deepCopy(o) {
  return JSON.parse(JSON.stringify(o));
}

/**
 * Convert screen coordinates to world coordinates
 * @param {number} sx 
 * @param {number} sy 
 * @param {Object} view 
 * @returns {Object} World coordinates {x, y}
 */
export function screenToWorld(sx, sy, view) {
  return { x: (sx - view.x) / view.scale, y: (sy - view.y) / view.scale };
}

/**
 * Convert world coordinates to screen coordinates
 * @param {number} wx 
 * @param {number} wy 
 * @param {Object} view 
 * @returns {Object} Screen coordinates {x, y}
 */
export function worldToScreen(wx, wy, view) {
  return { x: wx * view.scale + view.x, y: wy * view.scale + view.y };
}

/**
 * Show a toast message
 * @param {string} msg 
 */
export function toast(msg) {
  const t = document.getElementById('toast');
  if(!t) return;
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.style.opacity = '0', 1600);
}
