/**
 * Canvas rendering routines
 * @module renderer
 */

import { state, peers, peerId, selfPeerId } from './state.js';
import { screenToWorld, worldToScreen } from './utils.js';
import { connEndpoints, noteHandles, contentBounds } from './interaction.js';

export const DPR = Math.max(1, window.devicePixelRatio || 1);
export const GRID = 40;

let canvas, ctx, mm, mmx, stage;
let renderQueued = false;

// Image element cache: id -> HTMLImageElement
const imageCache = {};

// ── Lazy image src assignment ──────────────────────────────────────────────
// Setting `img.src` to a multi-MB base64 dataUrl forces the browser to parse
// the whole string synchronously; doing N of them in one render pass blocks the
// main thread (the "first screen frozen while images show placeholders"
// symptom). Instead we queue the assignment and pump the queue in small time
// slices (≤4ms per tick) so the UI stays responsive while placeholders spin.
const imageQueue = [];
let imagePumpTimer = null;

function pumpImageQueue() {
  const start = performance.now();
  while (imageQueue.length && performance.now() - start < 4) {
    const img = imageQueue.shift();
    img.src = img._dataUrl;
  }
  if (imageQueue.length) imagePumpTimer = setTimeout(pumpImageQueue, 0);
  else imagePumpTimer = null;
}

function queueImageSrc(img) {
  imageQueue.push(img);
  if (!imagePumpTimer) imagePumpTimer = setTimeout(pumpImageQueue, 0);
}

function unqueueImage(id) {
  for (let i = imageQueue.length - 1; i >= 0; i--) {
    if (imageQueue[i]._elId === id) imageQueue.splice(i, 1);
  }
}

// Images currently loading — used to drive the placeholder spinner animation.
// A non-empty set means requestRender() must fire periodically so the spinner
// arc rotates. Cleared on img.onload / img.onerror.
//
// The loop is throttled to SPINNER_FRAME_MS (~15fps): a 1 rotation/second arc
// looks identical at 15fps, but re-rendering the WHOLE scene at 60fps while N
// images load is the main first-screen blocker (each render re-sorts all ids,
// rebuilds the grid pattern and re-computes minimap bounds).
let imageLoadRafId = null;
let lastSpinnerFrame = 0;
const SPINNER_FRAME_MS = 66;
const loadingImages = new Set();

function startImageLoadAnim() {
  if (imageLoadRafId) return;
  function tick(now) {
    if (loadingImages.size === 0) { imageLoadRafId = null; return; }
    if (now - lastSpinnerFrame >= SPINNER_FRAME_MS) {
      lastSpinnerFrame = now;
      requestRender();
    }
    imageLoadRafId = requestAnimationFrame(tick);
  }
  imageLoadRafId = requestAnimationFrame(tick);
}

function stopImageLoadAnim() {
  if (imageLoadRafId) { cancelAnimationFrame(imageLoadRafId); imageLoadRafId = null; }
}

// Cached grid tile (offscreen canvas + bucket key from view scale)
let gridTile = null;
let gridTileBucket = -1;
// Pattern built from the tile — cached so we don't createPattern every frame.
let gridPattern = null;

// Cached stroke bounding boxes: id -> { bbox, points, len }
const strokeBboxCache = new Map();

// Cached contentBounds result
let boundsCache = null;

// GIF animation state: id -> { frames, durations, frameIndex, elapsed, pending }
const gifState = {};
let gifAnimRunning = false;
let gifRafId = null;

/**
 * Decode all frames of a GIF using the ImageDecoder API.
 * Returns null if ImageDecoder is unavailable (falls back to static first frame).
 */
async function decodeGifFrames(dataUrl) {
  if (typeof ImageDecoder === 'undefined') return null;
  let dec;
  try {
    const resp = await fetch(dataUrl);
    const buf = new Uint8Array(await resp.arrayBuffer());
    dec = new ImageDecoder({ data: buf, type: 'image/gif' });
    await dec.decode();
    const track = dec.track;
    const n = track.countFrames;
    if (!n) return null;

    const frames = [];
    const durations = [];
    for (let i = 0; i < n; i++) {
      track.selectFrame(i);
      await dec.update();
      // Copy to offscreen canvas — dec.image is invalidated by the next update()
      const w = dec.image.width, h = dec.image.height;
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(dec.image, 0, 0);
      dec.image.close(); // Free GPU memory immediately after copying
      frames.push(cv);
      const md = dec.getFrameMetadata(i);
      durations.push(md.duration > 0 ? md.duration : 100);
    }
    return { frames, durations };
  } catch (e) {
    return null;
  } finally {
    try { dec && dec.close(); } catch (_) {}
  }
}

function startGifAnim() {
  if (gifAnimRunning) return;
  gifAnimRunning = true;
  let last = performance.now();
  function tick(now) {
    if (!gifAnimRunning) return;
    const dt = now - last;
    last = now;
    let changed = false;
    for (const id in gifState) {
      const gs = gifState[id];
      // Clean up gifState entry if element was removed (undo/redo/room switch)
      if (!state.elements[id]) {
        delete gifState[id];
        if (!hasAnyGif()) stopGifAnim();
        continue;
      }
      if (!gs.frames || !gs.frames.length) continue;
      // Skip single-frame GIFs — wrapping modulo 1 wastes CPU
      if (gs.frames.length <= 1) continue;
      // Cap elapsed at 2s to prevent runaway iterations after tab backgrounded
      gs.elapsed = Math.min(gs.elapsed + dt, 2000);
      while (gs.elapsed >= (gs.durations[gs.frameIndex] || 100)) {
        gs.elapsed -= (gs.durations[gs.frameIndex] || 100);
        gs.frameIndex = (gs.frameIndex + 1) % gs.frames.length;
        changed = true;
      }
    }
    if (changed) requestRender();
    gifRafId = requestAnimationFrame(tick);
  }
  gifRafId = requestAnimationFrame(tick);
}

function stopGifAnim() {
  gifAnimRunning = false;
  if (gifRafId) { cancelAnimationFrame(gifRafId); gifRafId = null; }
}

function hasAnyGif() {
  return Object.keys(gifState).length > 0;
}

/**
 * Get or create a cached HTMLImageElement for an image element
 * @param {Object} el - Image element with dataUrl
 * @returns {HTMLImageElement}
 */
function getImageObj(el) {
  const cached = imageCache[el.id];
  if (cached && cached._dataUrl === el.dataUrl) return cached;

  // GIF: 触发异步帧解码（ImageDecoder API），解码完成后切到动画模式
  if (el.dataUrl && el.dataUrl.startsWith('data:image/gif') && !gifState[el.id]) {
    gifState[el.id] = { frames: null, durations: null, frameIndex: 0, elapsed: 0, pending: true };
    decodeGifFrames(el.dataUrl).then(result => {
      const gs = gifState[el.id];
      if (!gs) return; // 元素在解码期间被删除
      gs.frames = result ? result.frames : null;
      gs.durations = result ? result.durations : null;
      gs.pending = false;
      if (result && result.frames.length) {
        startGifAnim();
        requestRender();
      }
    });
  }

  // 换图（同一 id 换了 dataUrl）时丢弃队列里同 id 的旧 Image：它已被下面
  // imageCache[el.id] 覆盖、永远不会被绘制，却仍会白解析一次几 MB 的 base64；
  // 更糟的是旧 Image 的 onload 会执行 loadingImages.delete(el.id)，把新图
  // "仍在加载"的标记一并抹掉，导致转圈动画提前停止。
  unqueueImage(el.id);

  const img = new Image();
  img._dataUrl = el.dataUrl;
  img._elId = el.id;
  img.onload = () => {
    loadingImages.delete(el.id);
    requestRender();
    if (loadingImages.size === 0) stopImageLoadAnim();
  };
  img.onerror = () => {
    img.error = true;
    loadingImages.delete(el.id);
    requestRender();
    if (loadingImages.size === 0) stopImageLoadAnim();
  };
  imageCache[el.id] = img;
  loadingImages.add(el.id);
  startImageLoadAnim();
  queueImageSrc(img); // was: img.src = el.dataUrl;  — see lazy-loading note above
  return img;
}

/**
 * Remove cached image when element is deleted
 * @param {string} id - Element id
 */
export function clearImageCache(id) {
  delete imageCache[id];
  loadingImages.delete(id);
  unqueueImage(id);
  if (gifState[id]) {
    delete gifState[id];
    if (!hasAnyGif()) stopGifAnim();
  }
  if (loadingImages.size === 0) stopImageLoadAnim();
}

export function initRenderer() {
  canvas = document.getElementById('board');
  ctx = canvas.getContext('2d');
  stage = document.getElementById('stage');
  mm = document.getElementById('mm');
  mmx = mm.getContext('2d');
}

export function resize() {
  const newW = stage.clientWidth;
  const newH = stage.clientHeight;
  if (newW === state.W && newH === state.H) return;
  state.W = newW;
  state.H = newH;
  canvas.width = Math.round(state.W * DPR);
  canvas.height = Math.round(state.H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const mr = mm.getBoundingClientRect();
  mm.width = Math.round(mr.width * DPR);
  mm.height = Math.round(mr.height * DPR);
  mmx.setTransform(DPR, 0, 0, DPR, 0, 0);
  requestRender();
}

export function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
    drawMinimap();
  });
}

// Compute or return a cached bounding box for a stroke element.
// Invalidation: entries are discarded when the points array reference or its
// length changes (covers both "array replaced" and "push'd to in place").
function getStrokeBBox(el) {
  const cached = strokeBboxCache.get(el.id);
  if (cached && cached.points === el.points && cached.len === el.points.length) {
    return cached.bbox;
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of el.points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const halfW = (el.width || 1) / 2;
  const bbox = { x0: minX - halfW, y0: minY - halfW, x1: maxX + halfW, y1: maxY + halfW };
  strokeBboxCache.set(el.id, { bbox, points: el.points, len: el.points.length });
  return bbox;
}

// True if `el`'s bounding box does not intersect the (already margin-expanded)
// visible world rect. Connections are handled by their endpoints.
function isCulled(el, vr) {
  if (!el) return true;
  if (el.type === 'note' || el.type === 'image') {
    return el.x + el.w < vr.x0 || el.x > vr.x1 ||
           el.y + el.h < vr.y0 || el.y > vr.y1;
  }
  if (el.type === 'stroke') {
    const bb = getStrokeBBox(el);
    return bb.x1 < vr.x0 || bb.x0 > vr.x1 ||
           bb.y1 < vr.y0 || bb.y0 > vr.y1;
  }
  return false;
}

// Ids sorted by (el.z || 0) ascending, preserving insertion order for equal z.
// Uses a [id, originalIndex, z] tuple so the result is well-defined regardless
// of the host engine's sort stability.
//
// Cached on state.__mut: the order only changes when elements are added,
// removed or re-z'd, so re-sorting on every frame while images load (spinner
// loop) is pure waste. __mut is bumped by every mutation in state.js/network.js.
let sortedIdsCache = null;
let sortedIdsMut = -1;
function getSortedIds() {
  const mut = state.__mut || 0;
  if (sortedIdsCache && sortedIdsMut === mut) return sortedIdsCache;
  const ids = Object.keys(state.elements);
  const pairs = ids.map((id, i) => [id, i, state.elements[id].z || 0]);
  pairs.sort((a, b) => {
    if (a[2] !== b[2]) return a[2] - b[2];
    return a[1] - b[1];
  });
  const result = pairs.map(p => p[0]);
  sortedIdsCache = result;
  sortedIdsMut = mut;
  return result;
}

function render() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, state.W, state.H);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, state.W, state.H);

  ctx.save();
  ctx.translate(state.view.x, state.view.y);
  ctx.scale(state.view.scale, state.view.scale);
  drawGrid();

  // Visible world rect, expanded by ~120 device px for shadows/margins.
  const m = 120 / state.view.scale;
  const vr = {
    x0: -state.view.x / state.view.scale - m,
    y0: -state.view.y / state.view.scale - m,
    x1: (state.W - state.view.x) / state.view.scale + m,
    y1: (state.H - state.view.y) / state.view.scale + m,
  };
  const ids = getSortedIds();

  for (const id of ids) {
    const el = state.elements[id];
    if (el.type !== 'connection') continue;
    const fromEl = state.elements[el.from];
    const toEl = state.elements[el.to];
    if (!fromEl || !toEl) continue;
    if (isCulled(fromEl, vr) || isCulled(toEl, vr)) continue;
    drawConnection(el);
  }
  for (const id of ids) {
    const el = state.elements[id];
    if (el.type !== 'stroke') continue;
    if (isCulled(el, vr)) continue;
    drawStroke(el);
  }
  for (const id of ids) {
    const el = state.elements[id];
    if (el.type !== 'image') continue;
    if (isCulled(el, vr)) continue;
    drawImageEl(el);
  }
  for (const id of ids) {
    const el = state.elements[id];
    if (el.type !== 'note') continue;
    if (isCulled(el, vr)) continue;
    drawNote(el);
  }

  if (state.tool === 'connect' && state.connectFrom && state.drag && state.drag.mode === 'connect') {
    const a = state.elements[state.connectFrom];
    if (a) {
      const c = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
      ctx.strokeStyle = '#4c8bf5';
      ctx.lineWidth = 2 / state.view.scale;
      ctx.setLineDash([6 / state.view.scale, 5 / state.view.scale]);
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(state.pointerWorld.x, state.pointerWorld.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  ctx.restore();

  const sel = state.selectedId && state.elements[state.selectedId];
  if (sel && (sel.type === 'note' || sel.type === 'image')) {
    drawSelection(sel);
  }
  drawPeerCursors();
}

// Cached grid tile: a single offscreen canvas containing one 5*GRID x 5*GRID
// tile with the minor/major line pattern, rendered at the current view scale
// so lines stay 1 device-pixel wide.  Bucketed by scale so we only rebuild
// when zoom crosses a small threshold.
function getGridTile() {
  const scale = state.view.scale;
  const bucket = Math.round(scale * 8);
  if (gridTile && gridTileBucket === bucket) return gridTile;

  const px = Math.max(2, Math.round(GRID * 5 * scale));
  const c = document.createElement('canvas');
  c.width = px;
  c.height = px;
  const g = c.getContext('2d');
  const step = px / 5;

  // Minor lines: interior verticals/horizontals at 1..4 grid units.
  g.strokeStyle = '#eef0f4';
  g.lineWidth = 1;
  g.beginPath();
  for (let i = 1; i < 5; i++) {
    const p = i * step;
    g.moveTo(p, 0); g.lineTo(p, px);
    g.moveTo(0, p); g.lineTo(px, p);
  }
  g.stroke();

  // Major lines: tile edges (0 and px wrap to the same world coordinate when
  // tiled, so drawing both gives a full 1px line at every 5*GRID boundary).
  g.strokeStyle = '#e3e6ee';
  g.beginPath();
  g.moveTo(0, 0); g.lineTo(0, px);
  g.moveTo(0, 0); g.lineTo(px, 0);
  g.moveTo(px, 0); g.lineTo(px, px);
  g.moveTo(0, px); g.lineTo(px, px);
  g.stroke();

  gridTile = c;
  gridTileBucket = bucket;
  gridPattern = null; // tile replaced → pattern must be rebuilt
  return c;
}

function drawGrid() {
  const tile = getGridTile();
  if (!gridPattern) gridPattern = ctx.createPattern(tile, 'repeat');
  ctx.fillStyle = gridPattern;
  const x0 = -state.view.x / state.view.scale;
  const y0 = -state.view.y / state.view.scale;
  const x1 = (state.W - state.view.x) / state.view.scale;
  const y1 = (state.H - state.view.y) / state.view.scale;
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
}

function roundRect(c, x, y, w, h, r) {
  if (c.roundRect) {
    c.beginPath(); c.roundRect(x, y, w, h, r); return;
  }
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function drawSpinner(cx, cy, size) {
  const time = performance.now() / 1000;
  const startAngle = (time * 2 * Math.PI) % (2 * Math.PI); // 1 rotation per second
  const endAngle = startAngle + Math.PI * 1.5; // 270 degree arc

  ctx.save();
  ctx.strokeStyle = '#4f46e5';
  ctx.lineWidth = 3 / state.view.scale;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(cx, cy, size, startAngle, endAngle);
  ctx.stroke();
  ctx.restore();
}

function drawImagePlaceholder(el, img) {
  ctx.save();

  // Light background fill
  ctx.fillStyle = 'rgba(245,245,245,0.8)';
  roundRect(ctx, el.x, el.y, el.w, el.h, 6);
  ctx.fill();

  // Dashed border
  ctx.setLineDash([6 / state.view.scale, 4 / state.view.scale]);
  ctx.strokeStyle = '#bbb';
  ctx.lineWidth = 1.5 / state.view.scale;
  roundRect(ctx, el.x, el.y, el.w, el.h, 6);
  ctx.stroke();
  ctx.setLineDash([]);

  // Center position
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  const size = Math.max(8, Math.min(el.w, el.h) * 0.12);

  if (img && img.error) {
    // Error state: red X icon + label
    ctx.fillStyle = '#e74c3c';
    ctx.font = `bold ${Math.max(14, size * 2)}px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('✕', cx, cy - size * 0.3);
    ctx.font = `${Math.max(10, size)}px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif`;
    ctx.fillText('加载失败', cx, cy + size * 1.6);
  } else {
    // Loading state: animated spinner
    drawSpinner(cx, cy, size);
  }

  ctx.restore();
}

function drawImageEl(el) {
  let drawSource;

  // GIF with decoded frames: draw current animation frame
  const gs = gifState[el.id];
  if (el.dataUrl && el.dataUrl.startsWith('data:image/gif') && gs && gs.frames && gs.frames.length) {
    drawSource = gs.frames[gs.frameIndex];
  } else {
    // Static image or GIF fallback (first frame via HTMLImageElement)
    drawSource = getImageObj(el);
    if (!drawSource.complete || !drawSource.naturalWidth) {
      drawImagePlaceholder(el, drawSource);
      return;
    }
  }

  ctx.save();
  ctx.shadowColor = 'rgba(20,24,40,.12)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 4;
  roundRect(ctx, el.x, el.y, el.w, el.h, 6);
  ctx.clip();
  ctx.drawImage(drawSource, el.x, el.y, el.w, el.h);
  ctx.restore();

  // Subtle border
  ctx.save();
  ctx.strokeStyle = 'rgba(0,0,0,.10)';
  ctx.lineWidth = 1.5 / state.view.scale;
  roundRect(ctx, el.x, el.y, el.w, el.h, 6);
  ctx.stroke();
  ctx.restore();
}

function drawNote(n) {
  ctx.save();
  ctx.globalAlpha = (n.bgOpacity ?? 88) / 100;
  ctx.shadowColor = 'rgba(20,24,40,.16)';
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 5;
  roundRect(ctx, n.x, n.y, n.w, n.h, 12);
  ctx.fillStyle = n.color;
  ctx.fill();
  ctx.restore();
  
  ctx.save();
  ctx.globalAlpha = (n.textOpacity ?? 72) / 100;
  ctx.fillStyle = '#1c1f2b';
  const fs = n.fontSize || 16;
  ctx.font = `${fs}px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif`;
  ctx.textBaseline = 'top';
  const pad = Math.max(10, fs * 0.6);
  const lines = wrapText(n.text || '', n.w - pad * 2);
  let yy = n.y + pad;
  for (const ln of lines) {
    if (yy > n.y + n.h - pad) break;
    ctx.fillText(ln, n.x + pad, yy);
    yy += fs * 1.32;
  }
  ctx.restore();
}

function wrapText(text, maxW) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    if (raw === '') { out.push(''); continue; }
    let line = '';
    for (const ch of raw) {
      if (ctx.measureText(line + ch).width > maxW && line) {
        out.push(line);
        line = ch;
      } else {
        line += ch;
      }
    }
    out.push(line);
  }
  return out;
}

function drawStroke(s) {
  if (s.points.length < 1) return;
  ctx.strokeStyle = s.color;
  ctx.lineWidth = s.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(s.points[0].x, s.points[0].y);
  for (let i = 1; i < s.points.length; i++) {
    ctx.lineTo(s.points[i].x, s.points[i].y);
  }
  if (s.points.length === 1) {
    ctx.lineTo(s.points[0].x + 0.1, s.points[0].y + 0.1);
  }
  ctx.stroke();
}

function drawConnection(c) {
  const e = connEndpoints(c);
  if (!e) return;
  const col = c.color || '#9aa0b4';
  ctx.strokeStyle = col;
  ctx.lineWidth = 2 / state.view.scale;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(e.a.x, e.a.y);
  ctx.lineTo(e.b.x, e.b.y);
  ctx.stroke();
  
  const ang = Math.atan2(e.b.y - e.a.y, e.b.x - e.a.x);
  const ah = 10 / state.view.scale;
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.moveTo(e.b.x, e.b.y);
  ctx.lineTo(e.b.x - ah * Math.cos(ang - 0.4), e.b.y - ah * Math.sin(ang - 0.4));
  ctx.lineTo(e.b.x - ah * Math.cos(ang + 0.4), e.b.y - ah * Math.sin(ang + 0.4));
  ctx.closePath();
  ctx.fill();
}

function drawSelection(n) {
  const tl = worldToScreen(n.x, n.y, state.view);
  const w = n.w * state.view.scale;
  const h = n.h * state.view.scale;
  ctx.strokeStyle = '#4c8bf5';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([]);
  ctx.strokeRect(tl.x - 1, tl.y - 1, w + 2, h + 2);
  
  const { pts } = noteHandles(n);
  ctx.fillStyle = '#fff';
  for (const k in pts) {
    ctx.beginPath();
    ctx.rect(pts[k].x - 4, pts[k].y - 4, 8, 8);
    ctx.fill();
    ctx.stroke();
  }
}

function drawPeerCursors() {
  const now = performance.now();
  for (const id in peers) {
    // peers 的键是 PeerJS id，自己要用 selfPeerId 过滤（peerId 是本地随机的，留着兼容旧条目）
    if (id === peerId || id === selfPeerId) continue;
    const p = peers[id];
    if (!p.cursor || now - p.last > 12000) continue;
    const s = worldToScreen(p.cursor.x, p.cursor.y, state.view);
    if (s.x < -40 || s.y < -40 || s.x > state.W + 40 || s.y > state.H + 40) continue;
    
    ctx.save();
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(s.x, s.y + 16);
    ctx.lineTo(s.x + 4.5, s.y + 12);
    ctx.lineTo(s.x + 11, s.y + 11);
    ctx.closePath();
    ctx.fill();
    
    ctx.font = '11px sans-serif';
    const tw = ctx.measureText(p.name).width;
    ctx.fillStyle = p.color;
    ctx.fillRect(s.x + 10, s.y + 12, tw + 10, 16);
    ctx.fillStyle = '#fff';
    ctx.fillText(p.name, s.x + 15, s.y + 15);
    ctx.restore();
  }
}

// Cheap fingerprint cache for contentBounds().  The key is the mutation counter
// state.__mut: contentBounds() only changes when elements are added/removed
// (structural) or their geometry/text is committed (upsert/undo/redo), all of
// which bump __mut. Live drags mutate positions in place without bumping __mut,
// so the minimap may lag slightly during a drag and correct itself at
// pointerup — the same behavior as the old rev-sum fingerprint, but O(1) to
// check instead of O(n log n) string building every frame.
function getCachedContentBounds() {
  const mut = state.__mut || 0;
  if (boundsCache && boundsCache.mut === mut) return boundsCache.result;
  const result = contentBounds();
  boundsCache = { mut, result };
  return result;
}

function drawMinimap() {
  const mw = mm.clientWidth;
  const mh = mm.clientHeight;
  mmx.setTransform(DPR, 0, 0, DPR, 0, 0);
  mmx.clearRect(0, 0, mw, mh);
  mmx.fillStyle = '#fbfcfe';
  mmx.fillRect(0, 0, mw, mh);
  
  const cb = getCachedContentBounds();
  const vx0 = screenToWorld(0, 0, state.view);
  const vx1 = screenToWorld(state.W, state.H, state.view);
  const b = {
    minX: Math.min(cb.minX, vx0.x) - 40,
    minY: Math.min(cb.minY, vx0.y) - 40,
    maxX: Math.max(cb.maxX, vx1.x) + 40,
    maxY: Math.max(cb.maxY, vx1.y) + 40
  };
  const cw = Math.max(10, b.maxX - b.minX);
  const ch = Math.max(10, b.maxY - b.minY);
  const sc = Math.min(mw / cw, mh / ch);
  const ox = (mw - cw * sc) / 2;
  const oy = (mh - ch * sc) / 2;
  const tx = wx => ox + (wx - b.minX) * sc;
  const ty = wy => oy + (wy - b.minY) * sc;
  
  mm._map = { b, sc, ox, oy };
  
  for (const id in state.elements) {
    const el = state.elements[id];
    if (el.type === 'note') {
      mmx.fillStyle = el.color;
      mmx.fillRect(tx(el.x), ty(el.y), el.w * sc, el.h * sc);
    } else if (el.type === 'image') {
      mmx.fillStyle = '#c8cdd8';
      mmx.fillRect(tx(el.x), ty(el.y), el.w * sc, el.h * sc);
    } else if (el.type === 'stroke') {
      mmx.strokeStyle = el.color;
      mmx.lineWidth = 1;
      mmx.beginPath();
      el.points.forEach((pt, i) => i ? mmx.lineTo(tx(pt.x), ty(pt.y)) : mmx.moveTo(tx(pt.x), ty(pt.y)));
      mmx.stroke();
    }
  }
  mmx.strokeStyle = '#4c8bf5';
  mmx.lineWidth = 1.5;
  mmx.strokeRect(tx(vx0.x), ty(vx0.y), (vx1.x - vx0.x) * sc, (vx1.y - vx0.y) * sc);
}
